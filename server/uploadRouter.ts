import { Router } from "express";
import multer from "multer";
import fetch from "node-fetch";
import zlib from "zlib";
import { Readable } from "stream";
import { storagePut, storageGetSignedUrl } from "./storage";
import { createCampaign, getCampaignById, updateCampaign, createProcessingRun, findCampaignByClientAndSheet } from "./db";
import {
  detectClient,
  detectTargetSheet,
  processPaymentFiles,
} from "./paymentProcessor";
import { generatePaymentFiles, PaymentRow } from "./paymentFileGenerator";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

const router = Router();

// ─── Helper: fast ZIP-based sheet name extraction (no full workbook parse) ───
// Reads only xl/workbook.xml from the ZIP, which is tiny compared to the full file.
// This avoids ExcelJS loading all cell data and timing out on large .xlsm files.

function getSheetNamesFromZip(buffer: Buffer): string[] {
  try {
    let offset = 0;
    const results: string[] = [];

    while (offset < buffer.length - 4) {
      const sig = buffer.readUInt32LE(offset);
      if (sig === 0x04034b50) {
        // Local file header
        const compression = buffer.readUInt16LE(offset + 8);
        const compressedSize = buffer.readUInt32LE(offset + 18);
        const filenameLen = buffer.readUInt16LE(offset + 26);
        const extraLen = buffer.readUInt16LE(offset + 28);
        const filename = buffer.slice(offset + 30, offset + 30 + filenameLen).toString("utf8");
        const dataOffset = offset + 30 + filenameLen + extraLen;

        if (filename === "xl/workbook.xml" || filename === "xl/workbook.xml.rels") {
          const compressedData = buffer.slice(dataOffset, dataOffset + compressedSize);
          let xmlData: Buffer;
          if (compression === 0) {
            xmlData = compressedData;
          } else if (compression === 8) {
            xmlData = zlib.inflateRawSync(compressedData);
          } else {
            xmlData = compressedData;
          }

          if (filename === "xl/workbook.xml") {
            const xml = xmlData.toString("utf8");
            const regex = /<sheet\s[^>]*name="([^"]+)"/g;
            let m: RegExpExecArray | null;
            while ((m = regex.exec(xml)) !== null) {
              results.push(m[1]);
            }
            if (results.length > 0) return results;
          }
        }

        offset = dataOffset + compressedSize;
      } else if (sig === 0x02014b50 || sig === 0x06054b50) {
        break; // central directory
      } else {
        offset++;
      }
    }

    return results;
  } catch {
    return [];
  }
}

function getSheetNames(buffer: Buffer): string[] {
  return getSheetNamesFromZip(buffer);
}

// ─── POST /api/upload-campaign ────────────────────────────────────────────────
// First-time upload: stores the master file and creates a campaign record.
router.post(
  "/api/upload-campaign",
  upload.single("masterFile"),
  async (req, res) => {
    try {
      const file = req.file;
      if (!file) { res.status(400).json({ error: "masterFile is required" }); return; }

      // Detect client name and sheet names using the TypeScript processor (no Python needed)
      const sheetNames = await getSheetNames(file.buffer);
      const clientName = detectClient(file.originalname, sheetNames);

      // Pick the most likely default sheet name
      let sheetName = "";
      const keywords = ["poland", "france", "uk", "germany", "spain", "italy", "arkusz"];
      for (const s of sheetNames) {
        if (keywords.some(k => s.toLowerCase().includes(k))) {
          sheetName = s;
          break;
        }
      }
      if (!sheetName) {
        // Pick first non-RDB/merge sheet
        for (const s of sheetNames) {
          if (!s.toLowerCase().includes("rdb") && !s.toLowerCase().includes("merge")) {
            sheetName = s;
            break;
          }
        }
      }
      if (!sheetName && sheetNames.length > 0) sheetName = sheetNames[0];

      // Check for duplicate: same client + same sheet already exists
      if (clientName !== "Unknown" && sheetName) {
        const existing = await findCampaignByClientAndSheet(clientName, sheetName);
        if (existing) {
          res.status(409).json({
            error: `A campaign for ${clientName} (${sheetName} sheet) already exists: "${existing.name}". Use the Replace option on that campaign to update the master file instead.`,
            existingCampaignId: existing.id,
            existingCampaignName: existing.name,
          });
          return;
        }
      }

      // Store master file in S3
      const timestamp = Date.now();
      const safeFilename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const baseKey = `masters/${timestamp}_${safeFilename}`;
      const { key: storageKey } = await storagePut(baseKey, file.buffer, file.mimetype || "application/octet-stream");

      // Campaign name: original filename without extension
      const nameWithoutExt = file.originalname.replace(/\.[^.]+$/, "");
      const campaignName = nameWithoutExt || clientName;

      const id = await createCampaign({
        name: campaignName,
        clientName,
        storageKey,
        originalFilename: file.originalname,
        sheetName,
        sheetNames: JSON.stringify(sheetNames),
      });

      res.json({ id, name: campaignName, clientName, sheetName, sheetNames });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[upload-campaign] Error:", message);
      res.status(500).json({ error: message });
    }
  }
);

// ─── POST /api/process-payments ───────────────────────────────────────────────
// Process a weekly file against a stored (or uploaded) master file.
router.post(
  "/api/process-payments",
  upload.fields([
    { name: "weeklyFile", maxCount: 1 },
    { name: "masterFile", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const files = req.files as Record<string, Express.Multer.File[]>;
      const weeklyFiles = files["weeklyFile"];
      const masterFiles = files?.["masterFile"];
      const campaignId = req.body?.campaignId ? parseInt(req.body.campaignId) : undefined;
      const weeklySheet = (req.body?.weeklySheet) as string | undefined;
      const masterSheet = (req.body?.targetSheet || req.body?.masterSheet) as string | undefined;

      if (!weeklyFiles || weeklyFiles.length === 0) {
        res.status(400).json({ error: "Weekly file is required" });
        return;
      }

      const weeklyFile = weeklyFiles[0];
      let masterBuffer: Buffer;
      let masterFilename: string;
      let campaign = campaignId ? await getCampaignById(campaignId) : undefined;

      if (campaign) {
        // Load master from S3
        const signedUrl = await storageGetSignedUrl(campaign.storageKey);
        const masterRes = await fetch(signedUrl);
        if (!masterRes.ok) throw new Error("Failed to fetch stored master file from storage");
        masterBuffer = Buffer.from(await masterRes.arrayBuffer());
        masterFilename = campaign.originalFilename;
      } else if (masterFiles && masterFiles.length > 0) {
        masterBuffer = masterFiles[0].buffer;
        masterFilename = masterFiles[0].originalname;
      } else {
        res.status(400).json({ error: "Either campaignId or masterFile is required" });
        return;
      }

      // Process using the TypeScript processor (no Python needed)
      const result = await processPaymentFiles(
        masterBuffer,
        masterFilename,
        weeklyFile.buffer,
        weeklyFile.originalname
      );

      const fileBuffer = result.updatedMasterBuffer;

      // Validate the updated master buffer is a valid ZIP/XLSX before writing to S3.
      // XLSX/XLSM files are ZIP archives — they start with the PK magic bytes (0x50 0x4B).
      if (!fileBuffer || fileBuffer.length < 4 || fileBuffer[0] !== 0x50 || fileBuffer[1] !== 0x4B) {
        throw new Error("Updated master file is corrupted or empty — aborting to protect stored master");
      }

      // Store updated master back to S3
      const timestamp = Date.now();
      const safeFilename = masterFilename.replace(/[^a-zA-Z0-9._-]/g, "_");

      let storageKey: string;
      let newCampaignStorageKey: string | null = null; // deferred — only applied after history saves
      if (campaign) {
        const { key: newKey } = await storagePut(
          `masters/${timestamp}_${safeFilename}`,
          fileBuffer,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        storageKey = newKey;
        newCampaignStorageKey = newKey; // will be applied after history save succeeds
      } else {
        // No saved campaign — auto-save the master file as a new campaign so it
        // appears in the Campaigns tab and dropdown for future weekly runs.
        const masterSheetNames = getSheetNames(masterFiles![0].buffer);
        const detectedClientName = detectClient(masterFilename, masterSheetNames);
        const detectedSheetName = detectTargetSheet(masterSheetNames) || masterSheetNames[0] || "";

        // Store the *original* (pre-processing) master in S3 as the campaign master,
        // and the updated version separately for download.
        const masterTimestamp = Date.now();
        const { key: campaignMasterKey } = await storagePut(
          `masters/${masterTimestamp}_${safeFilename}`,
          masterFiles![0].buffer,
          masterFiles![0].mimetype || "application/octet-stream"
        );

        // Check for duplicate before creating
        const existingCampaign = detectedClientName !== "Unknown" && detectedSheetName
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
          campaign = await getCampaignById(newCampaignId) ?? undefined;
        } else {
          campaign = existingCampaign;
        }

        // Store the updated (post-processing) master for download
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

      // Collect all added rows from all sheet results
      type AddedRow = {
        firstName: string; lastName: string; email: string; paypalAccount: string;
        accountNumber: string; sortCode: string; iban: string; bic: string;
        value: number; currency: string; payType: string;
      };
      const allAddedRows: PaymentRow[] = (result.sheetResults ?? []).flatMap(
        (sr: { addedRows?: AddedRow[] }) =>
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
              const { key: pfKey } = await storagePut(
                `payment-files/${pfTimestamp}_${gf.filename}`,
                gf.buffer,
                gf.format.mimeType
              );
              return { label: gf.format.label, filename: gf.filename, downloadKey: pfKey, rowCount: gf.rowCount };
            })
          );
        } catch (pfErr) {
          console.error("[process-payments] Payment file generation failed:", pfErr);
          // Non-fatal — continue without payment files
        }
      }

      // Record the processing run in the history log
      try {
        await createProcessingRun({
          campaignId: campaign?.id ?? null,
          campaignName: campaign?.name ?? masterFilename,
          clientName: result.clientName || campaign?.clientName || "Unknown",
          weeklyFilename: weeklyFile.originalname,
          masterFilename,
          rowsProcessed: result.rowsInWeekly ?? 0,
          rowsAdded: result.rowsAdded ?? 0,
          rowsSkipped: result.rowsSkipped ?? 0,
          rowCountPass: result.rowCountPass ? 1 : 0,
          amountExpected: String(result.amountExpected ?? ""),
          amountActual: String(result.amountActual ?? ""),
          amountPass: result.amountPass ? 1 : 0,
          downloadKey: storageKey,
          sheetName: result.sheetResults?.map((r: { sheetName: string }) => r.sheetName).join(", ") || result.sheetName || campaign?.sheetName || "",
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

      // Exclude updatedMasterBuffer from response (it's a 27MB binary buffer)
      // The frontend uses downloadUrl to download the file separately
      const { updatedMasterBuffer: _buf, ...resultMeta } = result;
      res.json({
        result: resultMeta,
        downloadKey: storageKey,
        downloadUrl,
        originalFilename: masterFilename,
        campaignId: campaign?.id ?? null,
        paymentFiles: paymentFileResults,
      });
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[process-payments] Error:", message);
      res.status(err.statusCode || 500).json({ error: message });
    }
  }
);

// ─── POST /api/replace-campaign-master ────────────────────────────────────────
// Replace the master file for an existing campaign.
router.post(
  "/api/replace-campaign-master",
  upload.single("masterFile"),
  async (req, res) => {
    try {
      const file = req.file;
      const campaignId = req.body?.campaignId ? parseInt(req.body.campaignId) : undefined;
      if (!file) { res.status(400).json({ error: "masterFile is required" }); return; }
      if (!campaignId) { res.status(400).json({ error: "campaignId is required" }); return; }

      const campaign = await getCampaignById(campaignId);
      if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }

      // Re-detect sheet names using the TypeScript ZIP parser
      const sheetNames = await getSheetNames(file.buffer);
      const clientName = detectClient(file.originalname, sheetNames);

      // Store new master file in S3
      const timestamp = Date.now();
      const safeFilename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const { key: storageKey } = await storagePut(
        `masters/${timestamp}_${safeFilename}`,
        file.buffer,
        file.mimetype || "application/octet-stream"
      );

      await updateCampaign(campaignId, {
        storageKey,
        originalFilename: file.originalname,
        clientName,
        sheetNames: JSON.stringify(sheetNames),
      });

      res.json({ success: true, storageKey, sheetNames, clientName });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[replace-campaign-master] Error:", message);
      res.status(500).json({ error: message });
    }
  }
);

// ─── Chunked upload store ────────────────────────────────────────────────────
// Holds in-memory chunk maps keyed by uploadId. Each entry stores received
// chunks so large files can be sent in small pieces that stay under the
// reverse-proxy body-size limit (~8 MB). Entries are cleaned up after
// finalization or after a 10-minute TTL.
const chunkStore = new Map<string, {
  chunks: Map<number, Buffer>;
  totalChunks: number;
  filename: string;
  fieldName: string;
  createdAt: number;
}>();

// Evict stale uploads every 5 minutes
setInterval(() => {
  const now = Date.now();
  Array.from(chunkStore.entries()).forEach(([id, entry]) => {
    if (now - entry.createdAt > 10 * 60 * 1000) {
      chunkStore.delete(id);
    }
  });
}, 5 * 60 * 1000);

// ─── POST /api/upload-chunk ───────────────────────────────────────────────────
// Receives one chunk of a multipart file upload.
// Body fields: uploadId, chunkIndex, totalChunks, filename, fieldName
// File field: chunk (binary)
router.post(
  "/api/upload-chunk",
  upload.single("chunk"),
  (req, res) => {
    try {
      const { uploadId, chunkIndex, totalChunks, filename, fieldName } = req.body;
      if (!uploadId || chunkIndex === undefined || !totalChunks || !filename || !fieldName) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "No chunk data received" });
        return;
      }

      const idx = parseInt(chunkIndex, 10);
      const total = parseInt(totalChunks, 10);

      if (!chunkStore.has(uploadId)) {
        chunkStore.set(uploadId, {
          chunks: new Map(),
          totalChunks: total,
          filename,
          fieldName,
          createdAt: Date.now(),
        });
      }

      const entry = chunkStore.get(uploadId)!;
      entry.chunks.set(idx, req.file.buffer);

      res.json({ received: entry.chunks.size, total });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[upload-chunk] Error:", message);
      res.status(500).json({ error: message });
    }
  }
);

// ─── POST /api/finalize-upload ────────────────────────────────────────────────
// Reassembles chunks for one or more uploadIds, then runs the normal
// process-payments or upload-campaign logic on the assembled buffers.
// Body: { action, uploadIds: { masterFile?: string, weeklyFile?: string },
//         filenames: { masterFile?: string, weeklyFile?: string },
//         campaignId?, weeklySheet?, masterSheet? }
router.post("/api/finalize-upload", async (req, res) => {
  try {
    const { action, uploadIds, filenames, campaignId, weeklySheet, masterSheet } = req.body as {
      action: "process-payments" | "upload-campaign" | "replace-campaign-master";
      uploadIds: Record<string, string>;
      filenames: Record<string, string>;
      campaignId?: number;
      weeklySheet?: string;
      masterSheet?: string;
    };

    // Reassemble each uploaded file from its chunks
    const assembled: Record<string, { buffer: Buffer; filename: string }> = {};
    for (const [fieldName, uploadId] of Object.entries(uploadIds)) {
      const entry = chunkStore.get(uploadId);
      if (!entry) {
        res.status(400).json({ error: `Upload session not found for field: ${fieldName}` });
        return;
      }
      if (entry.chunks.size !== entry.totalChunks) {
        res.status(400).json({
          error: `Incomplete upload for ${fieldName}: received ${entry.chunks.size}/${entry.totalChunks} chunks`,
        });
        return;
      }
      const parts: Buffer[] = [];
      for (let i = 0; i < entry.totalChunks; i++) {
        const chunk = entry.chunks.get(i);
        if (!chunk) {
          res.status(400).json({ error: `Missing chunk ${i} for ${fieldName}` });
          return;
        }
        parts.push(chunk);
      }
      assembled[fieldName] = {
        buffer: Buffer.concat(parts),
        filename: filenames[fieldName] || entry.filename,
      };
      chunkStore.delete(uploadId);
    }

    // ── Delegate to the appropriate action ──────────────────────────────────
    if (action === "upload-campaign") {
      const master = assembled["masterFile"];
      if (!master) { res.status(400).json({ error: "masterFile chunks missing" }); return; }

      const sheetNames = getSheetNames(master.buffer);
      const clientName = detectClient(master.filename, sheetNames);

      let sheetName = "";
      const keywords = ["poland", "france", "uk", "germany", "spain", "italy", "arkusz"];
      for (const s of sheetNames) {
        if (keywords.some(k => s.toLowerCase().includes(k))) { sheetName = s; break; }
      }
      if (!sheetName) {
        for (const s of sheetNames) {
          if (!s.toLowerCase().includes("rdb") && !s.toLowerCase().includes("merge")) {
            sheetName = s; break;
          }
        }
      }
      if (!sheetName && sheetNames.length > 0) sheetName = sheetNames[0];

      if (clientName !== "Unknown" && sheetName) {
        const existing = await findCampaignByClientAndSheet(clientName, sheetName);
        if (existing) {
          res.status(409).json({
            error: `A campaign for ${clientName} (${sheetName} sheet) already exists: "${existing.name}". Use the Replace option on that campaign to update the master file instead.`,
            existingCampaignId: existing.id,
            existingCampaignName: existing.name,
          });
          return;
        }
      }

      const timestamp = Date.now();
      const safeFilename = master.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const { key: storageKey } = await storagePut(`masters/${timestamp}_${safeFilename}`, master.buffer, "application/octet-stream");
      const nameWithoutExt = master.filename.replace(/\.[^.]+$/, "");
      const id = await createCampaign({
        name: nameWithoutExt || clientName,
        clientName,
        storageKey,
        originalFilename: master.filename,
        sheetName,
        sheetNames: JSON.stringify(sheetNames),
      });
      res.json({ id, name: nameWithoutExt || clientName, clientName, sheetName, sheetNames });
      return;
    }

    if (action === "replace-campaign-master") {
      const master = assembled["masterFile"];
      if (!master) { res.status(400).json({ error: "masterFile chunks missing" }); return; }
      if (!campaignId) { res.status(400).json({ error: "campaignId is required" }); return; }

      const campaign = await getCampaignById(campaignId);
      if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }

      const sheetNames = getSheetNames(master.buffer);
      const clientName = detectClient(master.filename, sheetNames);
      const timestamp = Date.now();
      const safeFilename = master.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const { key: storageKey } = await storagePut(`masters/${timestamp}_${safeFilename}`, master.buffer, "application/octet-stream");
      await updateCampaign(campaignId, { storageKey, originalFilename: master.filename, clientName, sheetNames: JSON.stringify(sheetNames) });
      res.json({ success: true, storageKey, sheetNames, clientName });
      return;
    }

    // Default: process-payments
    const weekly = assembled["weeklyFile"];
    if (!weekly) { res.status(400).json({ error: "weeklyFile chunks missing" }); return; }

    let masterBuffer: Buffer;
    let masterFilename: string;
    let campaign = campaignId ? await getCampaignById(campaignId) : undefined;

    if (campaign) {
      const signedUrl = await storageGetSignedUrl(campaign.storageKey);
      const masterRes = await fetch(signedUrl);
      if (!masterRes.ok) throw new Error("Failed to fetch stored master file from storage");
      masterBuffer = Buffer.from(await masterRes.arrayBuffer());
      masterFilename = campaign.originalFilename;
    } else if (assembled["masterFile"]) {
      masterBuffer = assembled["masterFile"].buffer;
      masterFilename = assembled["masterFile"].filename;
    } else {
      res.status(400).json({ error: "Either campaignId or masterFile is required" });
      return;
    }

    // Reuse the same processing logic as /api/process-payments by building
    // fake multer-style file objects and delegating to a shared helper.
    // We inline the logic here to avoid duplicating the entire handler.
    const result = await processPaymentFiles(
      masterBuffer,
      masterFilename,
      weekly.buffer,
      weekly.filename
    );

    const fileBuffer = result.updatedMasterBuffer;
    if (!fileBuffer || fileBuffer.length < 4 || fileBuffer[0] !== 0x50 || fileBuffer[1] !== 0x4B) {
      throw new Error("Updated master file is corrupted or empty — aborting to protect stored master");
    }

    const timestamp = Date.now();
    const safeFilename = masterFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
    let storageKey: string;
    let newCampaignStorageKey: string | null = null;

    if (campaign) {
      const { key: newKey } = await storagePut(`masters/${timestamp}_${safeFilename}`, fileBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      storageKey = newKey;
      newCampaignStorageKey = newKey;
    } else {
      const masterSheetNames = getSheetNames(assembled["masterFile"]!.buffer);
      const detectedClientName = detectClient(masterFilename, masterSheetNames);
      const detectedSheetName = detectTargetSheet(masterSheetNames) || masterSheetNames[0] || "";
      const masterTimestamp = Date.now();
      const { key: campaignMasterKey } = await storagePut(`masters/${masterTimestamp}_${safeFilename}`, assembled["masterFile"]!.buffer, "application/octet-stream");
      const existingCampaign = detectedClientName !== "Unknown" && detectedSheetName
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
        campaign = await getCampaignById(newCampaignId) ?? undefined;
      } else {
        campaign = existingCampaign;
      }
      const { key: newKey } = await storagePut(`masters/${timestamp + 1}_${safeFilename}`, fileBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      storageKey = newKey;
    }

    const downloadUrl = await storageGetSignedUrl(storageKey);

    const paymentReference = result.clientName || campaign?.clientName || "Payment";
    const dateLabel = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-");
    type AddedRow = { firstName: string; lastName: string; email: string; paypalAccount: string; accountNumber: string; sortCode: string; iban: string; bic: string; value: number; currency: string; payType: string; };
    const allAddedRows: import("./paymentFileGenerator").PaymentRow[] = (result.sheetResults ?? []).flatMap(
      (sr: { addedRows?: AddedRow[] }) => (sr.addedRows ?? []).map((r: AddedRow) => ({ ...r, paymentReference }))
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
        console.error("[finalize-upload] Payment file generation failed:", pfErr);
      }
    }

    try {
      await createProcessingRun({
        campaignId: campaign?.id ?? null,
        campaignName: campaign?.name ?? masterFilename,
        clientName: result.clientName || campaign?.clientName || "Unknown",
        weeklyFilename: weekly.filename,
        masterFilename,
        rowsProcessed: result.rowsInWeekly ?? 0,
        rowsAdded: result.rowsAdded ?? 0,
        rowsSkipped: result.rowsSkipped ?? 0,
        rowCountPass: result.rowCountPass ? 1 : 0,
        amountExpected: String(result.amountExpected ?? ""),
        amountActual: String(result.amountActual ?? ""),
        amountPass: result.amountPass ? 1 : 0,
        downloadKey: storageKey,
        sheetName: result.sheetResults?.map((r: { sheetName: string }) => r.sheetName).join(", ") || result.sheetName || campaign?.sheetName || "",
        sheetResults: result.sheetResults
          ? JSON.stringify(result.sheetResults.map((sr) => { const { addedRows: _ar, ...meta } = sr as unknown as Record<string, unknown> & { addedRows?: unknown }; return meta; }))
          : null,
        paymentFiles: paymentFileResults.length > 0 ? JSON.stringify(paymentFileResults) : null,
      });
      if (newCampaignStorageKey && campaign) {
        await updateCampaign(campaign.id, {
          storageKey: newCampaignStorageKey,
          lastProcessedAt: new Date(),
          lastRowCount: (result.rowsAdded || 0) + (campaign.lastRowCount || 0),
        });
      }
    } catch (histErr) {
      console.error("[finalize-upload] Failed to record history:", histErr);
    }

    const { updatedMasterBuffer: _buf, ...resultMeta } = result;
    res.json({
      result: resultMeta,
      downloadKey: storageKey,
      downloadUrl,
      originalFilename: masterFilename,
      campaignId: campaign?.id ?? null,
      paymentFiles: paymentFileResults,
    });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[finalize-upload] Error:", message);
    res.status(err.statusCode || 500).json({ error: message });
  }
});

// ─── GET /api/worker-health ─────────────────────────────────────────────────
// Always returns ok — the TypeScript processor needs no separate process.
router.get("/api/worker-health", (_req, res) => {
  res.json({ workerStatus: "ok", engine: "typescript" });
});

// ─── GET /api/warmup ─────────────────────────────────────────────────────────
// No-op: TypeScript processor needs no warm-up.
router.get("/api/warmup", (_req, res) => {
  res.json({ status: "ok" });
});

// ─── GET /api/download ────────────────────────────────────────────────────────
// Proxy endpoint: streams a file from S3 with the correct Content-Disposition
// header so the browser downloads it with the right filename (no double extension).
router.get("/api/download", async (req, res) => {
  try {
    const key = req.query.key as string;
    const filename = (req.query.filename as string) || key.split("/").pop() || "download";
    if (!key) { res.status(400).json({ error: "key is required" }); return; }

    const signedUrl = await storageGetSignedUrl(key);
    const s3Resp = await fetch(signedUrl);
    if (!s3Resp.ok) {
      res.status(502).json({ error: "Failed to fetch file from storage" });
      return;
    }

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    const ct = s3Resp.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);

    // node-fetch response body is a Node.js ReadableStream — pipe it directly
    const nodeStream = s3Resp.body as unknown as NodeJS.ReadableStream;
    nodeStream.pipe(res);
    nodeStream.on("error", (err) => {
      console.error("[download] Stream error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Stream error" });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[download] Error:", message);
    if (!res.headersSent) res.status(500).json({ error: message });
  }
});

export default router;
