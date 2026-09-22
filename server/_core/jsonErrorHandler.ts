import type { ErrorRequestHandler } from "express";

/**
 * Last-resort error handler for the API surface. Without this, an error
 * that reaches Express before a route's own try/catch runs — a malformed
 * JSON body rejected by express.json(), a multer limit violation, a body
 * that's truncated mid-stream — falls through to Express's default error
 * handler, which renders an HTML page. A fetch() caller doing
 * `await res.json()` on that response throws, and the real error is hidden
 * behind a JSON-parse failure. Register this after every route so every
 * API error, wherever it originates, comes back as structured JSON.
 */
export const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  console.error("[API] Unhandled error:", err);
  const status =
    (err && typeof err === "object" && "statusCode" in err && typeof err.statusCode === "number" && err.statusCode) ||
    (err && typeof err === "object" && "status" in err && typeof err.status === "number" && err.status) ||
    500;
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(status).json({ error: message });
};
