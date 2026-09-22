// ─── Canonical process-payments business flow ────────────────────────────────
// Both /api/process-payments (single-request multer upload) and the
// "process-payments" action of /api/finalize-upload (reassembled chunked
// upload) delegate here. Previously each route carried its own ~150-line
// copy of this logic; they had already drifted (finalize-upload used a
// `timestamp + 1` workaround to dodge an S3 key collision that storagePut's
// random hash suffix already prevents). One implementation means the two
// entry points cannot diverge again.

import { storagePut, storageGetSignedUrl } from "./storage";
import {
  createCampaign,
  getCampaignById,
  updateCampaign,
  createProcessingRun,
  findCampaignByClientAndSheet,
} from "./db";
import { detectClient, detectTargetSheet, processPaymentFiles } from "./paymentProcessor";
import { generatePaymentFiles, PaymentRow } from "./paymentFileGenerator";
import { getSheetNames } from "./sheetNames";
import type { Campaign } from "../drizzle/schema";

export class FlowError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "FlowError";
    this.statusCode = statusCode;
  }
}

export type ProcessPaymentsFlowInput = {
  weeklyBuffer: Buffer;
  weeklyFilename: string;
  /** An existing saved campaign to process against. */
  campaignId?: number;
  /**
   * A master file buffer, required when no campaignId is given (or when the
   * caller wants to process against a freshly-uploaded master instead of a
   * saved one).
   */
  masterBuffer?: Buffer;
  masterFilename?: string;
};

export type ProcessPaymentsFlowResult = {
  result: Record<string, unknown>;
  downloadKey: string;
  downloadUrl: string;
  originalFilename: string;
  campaignId: number | null;
  paymentFiles: Array<{ label: string; filename: string; downloadKey: string; rowCount: number }>;
};

type AddedRow = {
  firstName: string;
  lastName: string;
  email: string;
  paypalAccount: string;
  accountNumber: string;
  sortCode: string;
  iban: string;
  bic: string;
  value: number;
  currency: string;
  payType: string;
};

export async function runProcessPaymentsFlow(
  input: ProcessPaymentsFlowInput
): Promise<ProcessPaymentsFlowResult> {
  const { weeklyBuffer, weeklyFilename, campaignId } = input;

  let masterBuffer: Buffer;
  let masterFilename: string;
  let campaign: Campaign | undefined = campaignId ? await getCampaignById(campaignId) : undefined;

  if (campaign) {
    const signedUrl = await storageGetSignedUrl(campaign.storageKey);
    const masterRes = await fetch(signedUrl);
    if (!masterRes.ok) throw new FlowError("Failed to fetch stored master file from storage", 502);
    masterBuffer = Buffer.from(await masterRes.arrayBuffer());
    masterFilename = campaign.originalFilename;
  } else if (input.masterBuffer && input.masterFilename) {
    masterBuffer = input.masterBuffer;
    masterFilename = input.masterFilename;
  } else {
    throw new FlowError("Either campaignId or masterFile is required", 400);
  }

  const result = await processPaymentFiles(masterBuffer, masterFilename, weeklyBuffer, weeklyFilename);

  const fileBuffer = result.updatedMasterBuffer;
  // XLSX/XLSM files are ZIP archives — they start with the PK magic bytes (0x50 0x4B).
  if (!fileBuffer || fileBuffer.length < 4 || fileBuffer[0] !== 0x50 || fileBuffer[1] !== 0x4b) {
    throw new FlowError("Updated master file is corrupted or empty — aborting to protect stored master", 500);
  }

  const timestamp = Date.now();
  const safeFilename = masterFilename.replace(/[^a-zA-Z0-9._-]/g, "_");

  let storageKey: string;
  // Deferred — only applied to the campaign after processing-run history saves,
  // so a history-save failure never leaves the campaign pointing at a new S3
  // key while the old master is still the one on record.
  let newCampaignStorageKey: string | null = null;

  if (campaign) {
    const { key: newKey } = await storagePut(
      `masters/${timestamp}_${safeFilename}`,
      fileBuffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    storageKey = newKey;
    newCampaignStorageKey = newKey;
  } else {
    // No saved campaign — auto-save the master file as a new campaign so it
    // appears in the Campaigns tab and dropdown for future weekly runs.
    const masterSheetNames = getSheetNames(input.masterBuffer!);
    const detectedClientName = detectClient(masterFilename, masterSheetNames);
    const detectedSheetName = detectTargetSheet(masterSheetNames) || masterSheetNames[0] || "";

    // Store the *original* (pre-processing) master in S3 as the campaign master,
    // and the updated version separately for download.
    const masterTimestamp = Date.now();
    const { key: campaignMasterKey } = await storagePut(
      `masters/${masterTimestamp}_${safeFilename}`,
      input.masterBuffer!,
      "application/octet-stream"
    );

    const existingCampaign =
      detectedClientName !== "Unknown" && detectedSheetName
        ? await findCampaignByClientAndSheet(detectedClientName, detectedSheetName)
        : null;

    if (!existingCampaign) {
      const nameWithoutExt = masterFilename.replace(/\.[^.]+$/, "");
      const newCampaignId = await createCampaign({
        name: nameWithoutExt || detectedClientName,
        clientName: detectedClientName,
        storageKey: campaignMasterKey,
        originalFilename: masterFilename,
        sheetName: detectedSheetName,
        sheetNames: JSON.stringify(masterSheetNames),
      });
      campaign = (await getCampaignById(newCampaignId)) ?? undefined;
    } else {
      campaign = existingCampaign;
    }

    // Store the updated (post-processing) master for download.
    const { key: newKey } = await storagePut(
      `processed/${masterTimestamp}_${safeFilename}`,
      fileBuffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    storageKey = newKey;
  }

  const downloadUrl = await storageGetSignedUrl(storageKey);

  // ── Generate payment instruction files from newly-added rows ──────────
  const paymentReference = result.clientName || campaign?.clientName || "Payment";
  const dateLabel = new Date()
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .replace(/ /g, "-");

  const allAddedRows: PaymentRow[] = (result.sheetResults ?? []).flatMap((sr: { addedRows?: AddedRow[] }) =>
    (sr.addedRows ?? []).map((r: AddedRow) => ({
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      paypalAccount: r.paypalAccount,
      accountNumber: r.accountNumber,
      sortCode: r.sortCode,
      iban: r.iban,
      bic: r.bic,
      value: r.value,
      currency: r.currency,
      payType: r.payType,
      paymentReference,
    }))
  );

  let paymentFileResults: Array<{ label: string; filename: string; downloadKey: string; rowCount: number }> = [];
  if (allAddedRows.length > 0) {
    try {
      const generatedFiles = await generatePaymentFiles(allAddedRows, paymentReference, dateLabel);
      paymentFileResults = await Promise.all(
        generatedFiles.map(async (gf) => {
          const pfTimestamp = Date.now();
          const { key: pfKey } = await storagePut(`payment-files/${pfTimestamp}_${gf.filename}`, gf.buffer, gf.format.mimeType);
          return { label: gf.format.label, filename: gf.filename, downloadKey: pfKey, rowCount: gf.rowCount };
        })
      );
    } catch (pfErr) {
      console.error("[process-payments] Payment file generation failed:", pfErr);
      // Non-fatal — continue without payment files.
    }
  }

  // Record the processing run in the history log.
  try {
    await createProcessingRun({
      campaignId: campaign?.id ?? null,
      campaignName: campaign?.name ?? masterFilename,
      clientName: result.clientName || campaign?.clientName || "Unknown",
      weeklyFilename,
      masterFilename,
      rowsProcessed: result.rowsInWeekly ?? 0,
      rowsAdded: result.rowsAdded ?? 0,
      rowsSkipped: result.rowsSkipped ?? 0,
      rowCountPass: result.rowCountPass ? 1 : 0,
      amountExpected: String(result.amountExpected ?? ""),
      amountActual: String(result.amountActual ?? ""),
      amountPass: result.amountPass ? 1 : 0,
      downloadKey: storageKey,
      sheetName:
        result.sheetResults?.map((r: { sheetName: string }) => r.sheetName).join(", ") ||
        result.sheetName ||
        campaign?.sheetName ||
        "",
      // Strip addedRows (full row data) before storing — only keep counts and
      // reconciliation metadata. This prevents TEXT column overflow for large runs.
      sheetResults: result.sheetResults
        ? JSON.stringify(
            result.sheetResults.map((sr) => {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { addedRows: _ar, ...meta } = sr as unknown as Record<string, unknown> & { addedRows?: unknown };
              return meta;
            })
          )
        : null,
      paymentFiles: paymentFileResults.length > 0 ? JSON.stringify(paymentFileResults) : null,
    });
    // Only update the campaign's storageKey after history saves successfully.
    // This prevents the campaign from pointing at a new S3 key if the history
    // save fails, which would leave the master in an inconsistent state.
    if (newCampaignStorageKey && campaign) {
      await updateCampaign(campaign.id, {
        storageKey: newCampaignStorageKey,
        lastProcessedAt: new Date(),
        lastRowCount: (result.rowsAdded || 0) + (campaign.lastRowCount || 0),
      });
    }
  } catch (histErr) {
    console.error("[process-payments] Failed to record history:", histErr);
    // Campaign storageKey intentionally NOT updated — old master remains safe.
  }

  // Exclude updatedMasterBuffer from the response (it can be tens of MB).
  // The frontend uses downloadUrl to download the file separately.
  const { updatedMasterBuffer: _buf, ...resultMeta } = result;
  return {
    result: resultMeta,
    downloadKey: storageKey,
    downloadUrl,
    originalFilename: masterFilename,
    campaignId: campaign?.id ?? null,
    paymentFiles: paymentFileResults,
  };
}
