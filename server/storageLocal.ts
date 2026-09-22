// ─── Local-disk storage adapter ───────────────────────────────────────────
// A drop-in stand-in for the Manus Forge-backed storage in server/storage.ts,
// used automatically when BUILT_IN_FORGE_API_URL/KEY are not configured
// (i.e. any environment outside Manus, such as a developer's machine running
// `pnpm dev` against a local database). Writes campaign masters, processing
// results, and generated payment files to a local directory and serves them
// back over HTTP via the /local-storage static route registered in
// server/_core/index.ts. Not for production use — see the "Recreate the
// Runtime Outside Manus" migration notes for the real S3-compatible
// replacement.

import fs from "fs";
import path from "path";
import crypto from "crypto";

export const LOCAL_STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  ? path.resolve(process.env.LOCAL_STORAGE_DIR)
  : path.resolve(process.cwd(), ".local-storage");

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

function baseUrl(): string {
  const port = process.env.PORT || "3000";
  return process.env.LOCAL_STORAGE_BASE_URL || `http://127.0.0.1:${port}`;
}

export async function storagePutLocal(
  relKey: string,
  data: Buffer | Uint8Array | string,
  _contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = appendHashSuffix(normalizeKey(relKey));
  const filePath = path.join(LOCAL_STORAGE_DIR, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.isBuffer(data) ? data : Buffer.from(data as string));
  return { key, url: `/local-storage/${key}` };
}

export async function storageGetLocal(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/local-storage/${key}` };
}

export async function storageGetSignedUrlLocal(relKey: string): Promise<string> {
  const key = normalizeKey(relKey);
  // uploadRouter re-fetches this URL itself (via node-fetch) to reload a
  // saved campaign's master, so it needs to be an absolute URL back to this
  // same server, not just a path.
  return `${baseUrl()}/local-storage/${key}`;
}
