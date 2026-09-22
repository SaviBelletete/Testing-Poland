/**
 * End-to-end test for the chunked upload path.
 *
 * Drives a real Express server (uploadRouter + the JSON-only error handler,
 * the same wiring server/_core/index.ts uses for the API surface) over real
 * HTTP: splits a synthetic master and weekly file into multiple chunks,
 * uploads each chunk to /api/upload-chunk, then finalizes via
 * /api/finalize-upload and asserts the response matches the normal
 * /api/process-payments response shape. This is the test CLAUDE.md's
 * "known unresolved work" asked for — it would have caught the
 * process-payments/finalize-upload divergence this branch fixes, and it
 * guards against the routes drifting apart again.
 *
 * Storage (S3) and the database are mocked in-memory — see the
 * `vi.mock("./storage", ...)` / `vi.mock("./db", ...)` blocks below — so the
 * test exercises real chunk reassembly and the real processing helper
 * without needing live infrastructure.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import JSZip from "jszip";
import ExcelJS from "exceljs";

// ─── Mocks: in-memory storage + database ──────────────────────────────────

vi.mock("./storage", () => {
  const store = new Map<string, Buffer>();
  return {
    storagePut: vi.fn(async (key: string, data: Buffer | Uint8Array | string) => {
      store.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data as any));
      return { key, url: `mock://${key}` };
    }),
    storageGetSignedUrl: vi.fn(async (key: string) => `mock://${key}`),
  };
});

vi.mock("./db", () => {
  let nextId = 1;
  const campaignsById = new Map<number, any>();
  return {
    createCampaign: vi.fn(async (data: any) => {
      const id = nextId++;
      campaignsById.set(id, { id, lastRowCount: 0, ...data });
      return id;
    }),
    getCampaignById: vi.fn(async (id: number) => campaignsById.get(id)),
    findCampaignByClientAndSheet: vi.fn(async () => undefined),
    updateCampaign: vi.fn(async (id: number, data: any) => {
      const existing = campaignsById.get(id);
      if (existing) campaignsById.set(id, { ...existing, ...data });
    }),
    createProcessingRun: vi.fn(async () => 1),
  };
});

// Import AFTER the mocks above so uploadRouter picks up the mocked modules.
const { default: uploadRouter } = await import("./uploadRouter");
const { jsonErrorHandler } = await import("./_core/jsonErrorHandler");

// ─── Synthetic file builders (same minimal-ZIP approach as
//     paymentProcessor.integration.test.ts) ────────────────────────────────

function buildSst(strings: string[]): string {
  const items = strings
    .map((s) => `<si><t>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

function buildSheetXml(headerRow: string[], dataRows: string[][]): string {
  const rows: string[] = [];
  const headerCells = headerRow
    .map((v, i) => `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>${v}</t></is></c>`)
    .join("");
  rows.push(`<row r="1">${headerCells}</row>`);
  dataRows.forEach((row, ri) => {
    const rowNum = ri + 2;
    const cells = row
      .map((v, ci) => {
        const col = String.fromCharCode(65 + ci);
        if (v === "") return `<c r="${col}${rowNum}"/>`;
        return `<c r="${col}${rowNum}" t="inlineStr"><is><t>${v.replace(/&/g, "&amp;")}</t></is></c>`;
      })
      .join("");
    rows.push(`<row r="${rowNum}">${cells}</row>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

/** Build a minimal .xlsm ZIP with one sheet named "UK", padded so it spans multiple chunks. */
async function buildMasterXlsm(existingRows: string[][]): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="UK" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`
  );

  const headers = [
    "Serial", "Submitted", "Validated", "User ID", "First Name", "Last Name",
    "Email", "Address 1", "Address 2", "City/Town", "Zip code",
    "Account Number", "BACS Sort Code", "IBAN", "BIC", "PayPal account",
    "Retailer", "Store", "Purchase Date", "Receipt ID", "Product Purchased",
    "Purchase Price", "Value", "Pay Type", "Comment", "Consumer ID",
    "Country", "Currency",
  ];
  zip.file("xl/worksheets/sheet1.xml", buildSheetXml(headers, existingRows));
  zip.file("xl/sharedStrings.xml", buildSst([]));

  // Padding file, uncompressed, so the resulting .xlsm reliably spans
  // several chunks at the small chunk sizes this test uses — a stand-in for
  // a real multi-megabyte master without committing a real spreadsheet.
  zip.file("xl/media/padding.bin", "P".repeat(20_000), { compression: "STORE" });

  return zip.generateAsync({ type: "nodebuffer" });
}

/** Build a minimal weekly .xlsx with a "UK" sheet, padded to span multiple chunks. */
async function buildWeeklyXlsx(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("UK");
  ws.addRow(["Weekly Payment Extract"]);
  ws.addRow([
    "Serial", "Submitted (UTC)", "Updated (UTC)", "Validated (UTC)", "Invalidated (UTC)",
    "Payment Approved (UTC)", "Valid Until (UTC)", "State", "User ID", "Title",
    "First Name", "Last Name", "Email", "Email verified", "Cheque First Name",
    "Cheque Last Name", "Address 1", "Address 2", "City/Town", "Zip code",
    "Account Number", "Bank Sort Code", "PayPal account", "Retailer", "Store",
    "Purchase Date (UTC)", "Purchase Date (store)", "Receipt ID", "Product Purchased", "Number of Products Purchased",
    "Purchase Price", "Country", "Currency", "Value", "Pay Type", "Comment", "Consumer ID",
  ]);
  for (const row of rows) ws.addRow(row);

  // Extra sheet of padding data so the workbook reliably spans several
  // chunks at the small chunk sizes this test uses.
  const padding = wb.addWorksheet("Padding");
  for (let i = 0; i < 400; i++) padding.addRow([`padding-row-${i}`, "x".repeat(40)]);

  return (await wb.xlsx.writeBuffer()) as Buffer;
}

// ─── Chunked upload driver (mirrors client/src/lib/chunkedUpload.ts) ──────

async function uploadInChunks(
  baseUrl: string,
  file: Buffer,
  filename: string,
  fieldName: string,
  chunkSize: number,
  chunkOrder: "forward" | "reverse" = "forward"
): Promise<{ uploadId: string; totalChunks: number }> {
  const uploadId = `${fieldName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const totalChunks = Math.ceil(file.length / chunkSize);
  const indices = Array.from({ length: totalChunks }, (_, i) => i);
  const orderedIndices = chunkOrder === "reverse" ? indices.slice().reverse() : indices;

  for (const i of orderedIndices) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, file.length);
    const chunk = file.subarray(start, end);

    const form = new FormData();
    form.append("uploadId", uploadId);
    form.append("chunkIndex", String(i));
    form.append("totalChunks", String(totalChunks));
    form.append("filename", filename);
    form.append("fieldName", fieldName);
    form.append("chunk", new Blob([chunk]), filename);

    const resp = await fetch(`${baseUrl}/api/upload-chunk`, { method: "POST", body: form });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(`chunk ${i}/${totalChunks} for ${fieldName} failed: ${body.error}`);
    }
  }

  return { uploadId, totalChunks };
}

// ─── Test server (same middleware wiring as server/_core/index.ts's API surface) ──

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.use(uploadRouter);
  app.use("/api", jsonErrorHandler);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("chunked upload → finalize (end-to-end)", () => {
  it("reassembles a multi-chunk master + weekly file and returns a normal process-payments response", async () => {
    const existingRow = [
      "SERIAL001", "2024-01-01", "2024-01-02", "USER001", "Alice", "Smith",
      "alice@test.com", "1 Main St", "", "London", "SW1A 1AA",
      "12345678", "20-00-00", "", "", "",
      "Tesco", "London Bridge", "2024-01-01", "RCPT001", "Product A",
      "10.00", "5.00", "BACS", "", "CONS001", "UK", "GBP",
    ];
    const masterBuf = await buildMasterXlsm([existingRow]);

    const weeklyRows: (string | number)[][] = [
      [
        "SERIAL001", "2024-01-01", "", "2024-01-02", "", "", "", "", "USER001", "",
        "Alice", "Smith", "alice@test.com", "", "", "",
        "1 Main St", "", "London", "SW1A 1AA",
        "12345678", "20-00-00", "", "Tesco", "London Bridge",
        "2024-01-01", "", "RCPT001", "Product A", "",
        "10.00", "UK", "GBP", "5.00", "BACS", "", "CONS001",
      ],
      [
        "SERIAL002", "2024-01-08", "", "2024-01-09", "", "", "", "", "USER002", "",
        "Bob", "Jones", "bob@test.com", "", "", "",
        "2 High St", "", "Manchester", "M1 1AA",
        "87654321", "30-00-00", "", "Asda", "Manchester",
        "2024-01-08", "", "RCPT002", "Product B", "",
        "20.00", "UK", "GBP", "8.00", "BACS", "", "CONS002",
      ],
    ];
    const weeklyBuf = await buildWeeklyXlsx(weeklyRows);

    // A small chunk size forces both files into several chunks — this is
    // the scenario the reverse-proxy body-size limit forces in production.
    const CHUNK_SIZE = 4_000;
    expect(masterBuf.length).toBeGreaterThan(CHUNK_SIZE * 2);
    expect(weeklyBuf.length).toBeGreaterThan(CHUNK_SIZE * 2);

    const master = await uploadInChunks(baseUrl, masterBuf, "SC_Johnson_Master.xlsm", "masterFile", CHUNK_SIZE);
    const weekly = await uploadInChunks(baseUrl, weeklyBuf, "extractedSCJ.xlsx", "weeklyFile", CHUNK_SIZE);
    expect(master.totalChunks).toBeGreaterThan(1);
    expect(weekly.totalChunks).toBeGreaterThan(1);

    const res = await fetch(`${baseUrl}/api/finalize-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "process-payments",
        uploadIds: { masterFile: master.uploadId, weeklyFile: weekly.uploadId },
        filenames: { masterFile: "SC_Johnson_Master.xlsm", weeklyFile: "extractedSCJ.xlsx" },
      }),
    });

    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(res.status, `expected 200, got ${res.status}: ${JSON.stringify(body)}`).toBe(200);

    // Same response shape /api/process-payments returns for the same inputs.
    expect(body.result.rowsAdded).toBe(1);
    expect(body.result.rowsSkipped).toBe(1);
    expect(body.result.updatedMasterBuffer).toBeUndefined();
    expect(typeof body.downloadKey).toBe("string");
    expect(typeof body.downloadUrl).toBe("string");
    expect(typeof body.campaignId).toBe("number");
    expect(Array.isArray(body.paymentFiles)).toBe(true);
  }, 30000);

  it("reassembles chunks correctly regardless of upload arrival order", async () => {
    const masterBuf = await buildMasterXlsm([]);
    const weeklyBuf = await buildWeeklyXlsx([
      [
        "SERIAL010", "2024-02-01", "", "2024-02-02", "", "", "", "", "USER010", "",
        "Cara", "Lee", "cara@test.com", "", "", "",
        "3 Low St", "", "Leeds", "LS1 1AA",
        "11122233", "40-00-00", "", "Tesco", "Leeds",
        "2024-02-01", "", "RCPT010", "Product C", "",
        "15.00", "UK", "GBP", "6.00", "BACS", "", "CONS010",
      ],
    ]);

    const CHUNK_SIZE = 3_500;
    const master = await uploadInChunks(baseUrl, masterBuf, "SC_Johnson_Master.xlsm", "masterFile", CHUNK_SIZE, "reverse");
    const weekly = await uploadInChunks(baseUrl, weeklyBuf, "extractedSCJ.xlsx", "weeklyFile", CHUNK_SIZE, "reverse");
    expect(master.totalChunks).toBeGreaterThan(1);

    const res = await fetch(`${baseUrl}/api/finalize-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "process-payments",
        uploadIds: { masterFile: master.uploadId, weeklyFile: weekly.uploadId },
        filenames: { masterFile: "SC_Johnson_Master.xlsm", weeklyFile: "extractedSCJ.xlsx" },
      }),
    });

    const body = await res.json();
    expect(res.status, `expected 200, got ${res.status}: ${JSON.stringify(body)}`).toBe(200);
    expect(body.result.rowsAdded).toBe(1);
    expect(body.result.rowsSkipped).toBe(0);
  }, 30000);

  it("returns a structured JSON error, not an HTML page, for a malformed finalize-upload body", async () => {
    const res = await fetch(`${baseUrl}/api/finalize-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not valid json",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("text/html");
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("returns a structured JSON error for an incomplete chunk set", async () => {
    const weeklyBuf = await buildWeeklyXlsx([]);
    const CHUNK_SIZE = 3_000;
    const uploadId = `weeklyFile-${Date.now()}-incomplete`;
    const totalChunks = Math.max(2, Math.ceil(weeklyBuf.length / CHUNK_SIZE));

    // Upload only the first chunk out of several.
    const form = new FormData();
    form.append("uploadId", uploadId);
    form.append("chunkIndex", "0");
    form.append("totalChunks", String(totalChunks));
    form.append("filename", "extractedSCJ.xlsx");
    form.append("fieldName", "weeklyFile");
    form.append("chunk", new Blob([weeklyBuf.subarray(0, CHUNK_SIZE)]), "extractedSCJ.xlsx");
    const chunkRes = await fetch(`${baseUrl}/api/upload-chunk`, { method: "POST", body: form });
    expect(chunkRes.ok).toBe(true);

    const res = await fetch(`${baseUrl}/api/finalize-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "process-payments",
        uploadIds: { weeklyFile: uploadId },
        filenames: { weeklyFile: "extractedSCJ.xlsx" },
        campaignId: 999999,
      }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toMatch(/Incomplete upload/);
  });
});
