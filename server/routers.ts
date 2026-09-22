import { z } from "zod";
import fetch from "node-fetch";
import zlib from "zlib";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import {
  listCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
  listProcessingRuns,
  listRunsByCampaign,
} from "./db";
import { storageGetSignedUrl } from "./storage";

// Fast ZIP-based sheet name extraction (mirrors the logic in uploadRouter.ts)
function getSheetNamesFromBuffer(buffer: Buffer): string[] {
  try {
    let offset = 0;
    const results: string[] = [];
    while (offset < buffer.length - 4) {
      const sig = buffer.readUInt32LE(offset);
      if (sig === 0x04034b50) {
        const compression = buffer.readUInt16LE(offset + 8);
        const compressedSize = buffer.readUInt32LE(offset + 18);
        const filenameLen = buffer.readUInt16LE(offset + 26);
        const extraLen = buffer.readUInt16LE(offset + 28);
        const filename = buffer.slice(offset + 30, offset + 30 + filenameLen).toString("utf8");
        const dataOffset = offset + 30 + filenameLen + extraLen;
        if (filename === "xl/workbook.xml") {
          const compressed = buffer.slice(dataOffset, dataOffset + compressedSize);
          const xml = (compression === 8 ? zlib.inflateRawSync(compressed) : compressed).toString("utf8");
          const regex = /<sheet\s[^>]*name="([^"]+)"/g;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(xml)) !== null) results.push(m[1]);
          if (results.length > 0) return results;
        }
        offset = dataOffset + compressedSize;
      } else if (sig === 0x02014b50 || sig === 0x06054b50) {
        break;
      } else {
        offset++;
      }
    }
    return results;
  } catch {
    return [];
  }
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  campaigns: router({
    /** List all stored campaigns */
    list: publicProcedure.query(async () => {
      return listCampaigns();
    }),

    /** Get a single campaign by ID */
    get: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return getCampaignById(input.id);
      }),

    /** Get a fresh download URL for a campaign's master file */
    getMasterUrl: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const campaign = await getCampaignById(input.id);
        if (!campaign) throw new Error("Campaign not found");
        const url = await storageGetSignedUrl(campaign.storageKey);
        return { url, filename: campaign.originalFilename };
      }),

    /** Rename a campaign */
    rename: publicProcedure
      .input(z.object({ id: z.number(), name: z.string().min(1).max(255) }))
      .mutation(async ({ input }) => {
        await updateCampaign(input.id, { name: input.name });
        return { success: true };
      }),

    /** Delete a campaign (removes DB record; S3 object becomes unreferenced) */
    delete: publicProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deleteCampaign(input.id);
        return { success: true };
      }),

    /** Get the list of available sheets for a campaign's master file */
    getSheets: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const campaign = await getCampaignById(input.id);
        if (!campaign) throw new Error("Campaign not found");
        let sheetNames: string[] = [];
        try { sheetNames = JSON.parse(campaign.sheetNames || "[]"); } catch {}
        return {
          sheetNames,
          defaultSheet: campaign.sheetName,
        };
      }),

    /**
     * Re-detect sheet names from the stored master file using the TypeScript ZIP parser.
     * No Python worker required. Updates the campaign's sheetName / sheetNames in the DB.
     * Returns { ready: true, sheetNames, sheetName } on success.
     */
    refreshSheets: publicProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const campaign = await getCampaignById(input.id);
        if (!campaign) throw new Error("Campaign not found");

        // Fetch the master file from S3
        const signedUrl = await storageGetSignedUrl(campaign.storageKey);
        const fileRes = await fetch(signedUrl);
        if (!fileRes.ok) throw new Error("Failed to fetch master file from storage");
        const fileBuffer = Buffer.from(await fileRes.arrayBuffer());

        // Use the TypeScript ZIP-based sheet name extractor (instant, no Python needed)
        const sheetNames = getSheetNamesFromBuffer(fileBuffer);
        if (sheetNames.length === 0) return { ready: false as const };

        // Keep existing sheetName if it's still valid; otherwise pick first
        const sheetName = sheetNames.includes(campaign.sheetName)
          ? campaign.sheetName
          : (sheetNames[0] ?? "");

        await updateCampaign(campaign.id, { sheetName, sheetNames: JSON.stringify(sheetNames) });
        return { ready: true as const, sheetName, sheetNames };
      }),
  }),

  history: router({
    /** List all processing runs, most recent first */
    list: publicProcedure
      .input(z.object({ limit: z.number().min(1).max(500).optional() }))
      .query(async ({ input }) => {
        return listProcessingRuns(input.limit ?? 100);
      }),

    /** List processing runs for a specific campaign */
    byCampaign: publicProcedure
      .input(z.object({ campaignId: z.number() }))
      .query(async ({ input }) => {
        return listRunsByCampaign(input.campaignId);
      }),

    /** Get a fresh download URL for a run's output master file */
    getDownloadUrl: publicProcedure
      .input(z.object({ downloadKey: z.string(), filename: z.string() }))
      .query(async ({ input }) => {
        if (!input.downloadKey) throw new Error("No download key for this run");
        const url = await storageGetSignedUrl(input.downloadKey);
        return { url, filename: input.filename };
      }),

    /** Export processing history as CSV string */
    exportCsv: publicProcedure
      .input(z.object({ campaignId: z.number().optional() }))
      .query(async ({ input }) => {
        const runs = input.campaignId
          ? await listRunsByCampaign(input.campaignId)
          : await listProcessingRuns(500);

        const headers = [
          "Date", "Campaign", "Client", "Sheet", "Weekly File",
          "Rows Processed", "Rows Added", "Rows Skipped",
          "Row Count Check", "Amount Expected", "Amount Actual", "Amount Check"
        ];

        const escape = (v: unknown) => {
          const s = String(v ?? "");
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        };

        const rows = runs.map(r => [
          new Date(r.processedAt).toISOString(),
          r.campaignName,
          r.clientName,
          r.sheetName,
          r.weeklyFilename,
          r.rowsProcessed,
          r.rowsAdded,
          r.rowsSkipped,
          r.rowCountPass ? "PASS" : "FAIL",
          r.amountExpected,
          r.amountActual,
          r.amountPass ? "PASS" : "FAIL",
        ].map(escape).join(","));

        const csv = [headers.join(","), ...rows].join("\n");
        return { csv, count: runs.length };
      }),
  }),
});

export type AppRouter = typeof appRouter;
