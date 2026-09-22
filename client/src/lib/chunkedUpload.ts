/**
 * Chunked file upload utility.
 *
 * Splits a File into CHUNK_SIZE pieces and POSTs each one to /api/upload-chunk.
 * Returns an uploadId that can be passed to /api/finalize-upload.
 *
 * Files smaller than CHUNK_THRESHOLD are uploaded as a single chunk so the
 * normal fast path is preserved for small files.
 */

const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per chunk — safely under proxy limit
const CHUNK_THRESHOLD = 6 * 1024 * 1024; // only chunk files > 6 MB

export type UploadProgressCallback = (pct: number) => void;

/**
 * Upload a single file using chunked transfer.
 * Returns the uploadId to use in /api/finalize-upload.
 */
export async function uploadFileInChunks(
  file: File,
  fieldName: string,
  onProgress?: UploadProgressCallback
): Promise<string> {
  const uploadId = `${fieldName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const blob = file.slice(start, end);

    const form = new FormData();
    form.append("uploadId", uploadId);
    form.append("chunkIndex", String(i));
    form.append("totalChunks", String(totalChunks));
    form.append("filename", file.name);
    form.append("fieldName", fieldName);
    form.append("chunk", blob, file.name);

    const resp = await fetch("/api/upload-chunk", { method: "POST", body: form });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(`Chunk ${i + 1}/${totalChunks} failed: ${err.error || resp.statusText}`);
    }

    if (onProgress) {
      onProgress(Math.round(((i + 1) / totalChunks) * 100));
    }
  }

  return uploadId;
}

/**
 * Decide whether a file needs chunked upload.
 * Small files go through the normal single-request path.
 */
export function needsChunkedUpload(file: File): boolean {
  return file.size > CHUNK_THRESHOLD;
}
