import { Router, type Response } from "express";
import multer from "multer";
import fetch from "node-fetch";
import { storagePut, storageGetSignedUrl } from "./storage";
import { createCampaign, getCampaignById, updateCampaign, findCampaignByClientAndSheet } from "./db";
import { detectClient } from "./paymentProcessor";
import { getSheetNames, pickDefaultSheetName } from "./sheetNames";
import { runProcessPaymentsFlow, FlowError } from "./processPaymentsFlow";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

const router = Router();

/** Send a structured JSON error response, honoring FlowError's statusCode. */
function sendError(res: Response, routeLabel: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const statusCode = err instanceof FlowError ? err.statusCode : (err as { statusCode?: number })?.statusCode || 500;
  console.error(`[${routeLabel}] Error:`, message);
  res.status(statusCode).json({ error: message });
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
      const sheetNames = getSheetNames(file.buffer);
      const clientName = detectClient(file.originalname, sheetNames);
      const sheetName = sheetNames.length > 0 ? pickDefaultSheetName(sheetNames) : "";

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
      sendError(res, "upload-campaign", err);
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

      if (!weeklyFiles || weeklyFiles.length === 0) {
        res.status(400).json({ error: "Weekly file is required" });
        return;
      }
      const weeklyFile = weeklyFiles[0];

      const flowResult = await runProcessPaymentsFlow({
        weeklyBuffer: weeklyFile.buffer,
        weeklyFilename: weeklyFile.originalname,
        campaignId,
        masterBuffer: masterFiles?.[0]?.buffer,
        masterFilename: masterFiles?.[0]?.originalname,
      });

      res.json(flowResult);
    } catch (err) {
      sendError(res, "process-payments", err);
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
      const sheetNames = getSheetNames(file.buffer);
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
      sendError(res, "replace-campaign-master", err);
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
      sendError(res, "upload-chunk", err);
    }
  }
);

/** Reassemble one chunked upload into a single buffer. Throws FlowError (400) on any gap. */
function reassembleChunks(uploadId: string, fieldName: string): { buffer: Buffer; filename: string } {
  const entry = chunkStore.get(uploadId);
  if (!entry) {
    throw new FlowError(`Upload session not found for field: ${fieldName}`, 400);
  }
  if (entry.chunks.size !== entry.totalChunks) {
    throw new FlowError(
      `Incomplete upload for ${fieldName}: received ${entry.chunks.size}/${entry.totalChunks} chunks`,
      400
    );
  }
  const parts: Buffer[] = [];
  for (let i = 0; i < entry.totalChunks; i++) {
    const chunk = entry.chunks.get(i);
    if (!chunk) {
      throw new FlowError(`Missing chunk ${i} for ${fieldName}`, 400);
    }
    parts.push(chunk);
  }
  chunkStore.delete(uploadId);
  return { buffer: Buffer.concat(parts), filename: entry.filename };
}

// ─── POST /api/finalize-upload ────────────────────────────────────────────────
// Reassembles chunks for one or more uploadIds, then runs the normal
// process-payments / upload-campaign / replace-campaign-master logic on the
// assembled buffers via the same helpers the single-request routes use, so
// this path cannot silently diverge from them.
// Body: { action, uploadIds: { masterFile?: string, weeklyFile?: string },
//         filenames: { masterFile?: string, weeklyFile?: string },
//         campaignId?, weeklySheet?, masterSheet? }
router.post("/api/finalize-upload", async (req, res) => {
  try {
    const { action, uploadIds, filenames, campaignId } = req.body as {
      action?: "process-payments" | "upload-campaign" | "replace-campaign-master";
      uploadIds: Record<string, string>;
      filenames: Record<string, string>;
      campaignId?: number;
      weeklySheet?: string;
      masterSheet?: string;
    };

    if (!uploadIds || typeof uploadIds !== "object") {
      res.status(400).json({ error: "uploadIds is required" });
      return;
    }

    // Reassemble each uploaded file from its chunks
    const assembled: Record<string, { buffer: Buffer; filename: string }> = {};
    for (const [fieldName, uploadId] of Object.entries(uploadIds)) {
      const { buffer, filename: defaultFilename } = reassembleChunks(uploadId, fieldName);
      assembled[fieldName] = { buffer, filename: filenames?.[fieldName] || defaultFilename };
    }

    // ── Delegate to the appropriate action ──────────────────────────────────
    if (action === "upload-campaign") {
      const master = assembled["masterFile"];
      if (!master) { res.status(400).json({ error: "masterFile chunks missing" }); return; }

      const sheetNames = getSheetNames(master.buffer);
      const clientName = detectClient(master.filename, sheetNames);
      const sheetName = sheetNames.length > 0 ? pickDefaultSheetName(sheetNames) : "";

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

    // Default: process-payments — same helper /api/process-payments uses.
    const weekly = assembled["weeklyFile"];
    if (!weekly) { res.status(400).json({ error: "weeklyFile chunks missing" }); return; }

    const flowResult = await runProcessPaymentsFlow({
      weeklyBuffer: weekly.buffer,
      weeklyFilename: weekly.filename,
      campaignId,
      masterBuffer: assembled["masterFile"]?.buffer,
      masterFilename: assembled["masterFile"]?.filename,
    });

    res.json(flowResult);
  } catch (err) {
    sendError(res, "finalize-upload", err);
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
    sendError(res, "download", err);
  }
});

export default router;
