/**
 * Integration test: ZIP-surgical processor with new rows
 *
 * Creates a minimal .xlsm ZIP (just the required XML files) with one existing
 * data row, then processes a weekly file containing one duplicate and one new row.
 * Verifies that:
 *   - The new row is appended to the correct sheet
 *   - The duplicate is skipped
 *   - The returned ZIP is valid and contains the new row
 */

import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { processPaymentFiles } from "./paymentProcessor";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal shared strings XML with the given strings */
function buildSst(strings: string[]): string {
  const items = strings
    .map((s) => `<si><t>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

/** Build a minimal sheet XML with a header row and given data rows (string cells only) */
function buildSheetXml(headerRow: string[], dataRows: string[][]): string {
  const rows: string[] = [];

  // Header row (row 1) — inline strings
  const headerCells = headerRow
    .map((v, i) => {
      const col = String.fromCharCode(65 + i);
      return `<c r="${col}1" t="inlineStr"><is><t>${v}</t></is></c>`;
    })
    .join("");
  rows.push(`<row r="1">${headerCells}</row>`);

  // Data rows — shared string indices (we'll use inline for simplicity in test)
  dataRows.forEach((row, ri) => {
    const rowNum = ri + 2;
    const cells = row
      .map((v, ci) => {
        const col = String.fromCharCode(65 + ci);
        if (v === "") return `<c r="${col}${rowNum}"/>`;
        // Use inline string for test simplicity
        return `<c r="${col}${rowNum}" t="inlineStr"><is><t>${v.replace(/&/g, "&amp;")}</t></is></c>`;
      })
      .join("");
    rows.push(`<row r="${rowNum}">${cells}</row>`);
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

/** Build a minimal .xlsm ZIP with one sheet named "UK" */
async function buildMasterXlsm(existingRows: string[][]): Promise<Buffer> {
  const zip = new JSZip();

  // [Content_Types].xml
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

  // _rels/.rels
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  );

  // xl/workbook.xml
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="UK" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`
  );

  // xl/_rels/workbook.xml.rels
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`
  );

  // Headers matching the master column layout (A=Serial, B=Submitted, ... W=Value)
  const headers = [
    "Serial", "Submitted", "Validated", "User ID", "First Name", "Last Name",
    "Email", "Address 1", "Address 2", "City/Town", "Zip code",
    "Account Number", "BACS Sort Code", "IBAN", "BIC", "PayPal account",
    "Retailer", "Store", "Purchase Date", "Receipt ID", "Product Purchased",
    "Purchase Price", "Value", "Pay Type", "Comment", "Consumer ID",
    "Country", "Currency",
  ];

  // xl/worksheets/sheet1.xml
  zip.file("xl/worksheets/sheet1.xml", buildSheetXml(headers, existingRows));

  // xl/sharedStrings.xml (empty SST — we use inline strings in test)
  zip.file("xl/sharedStrings.xml", buildSst([]));

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return buf;
}

/** Build a minimal weekly .xlsx with a "UK" sheet */
async function buildWeeklyXlsx(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("UK");

  // Row 1: title (skipped by processor)
  ws.addRow(["Weekly Payment Extract"]);

  // Row 2: headers matching the real weekly file format
  ws.addRow([
    "Serial", "Submitted (UTC)", "Updated (UTC)", "Validated (UTC)", "Invalidated (UTC)",
    "Payment Approved (UTC)", "Valid Until (UTC)", "State", "User ID", "Title",
    "First Name", "Last Name", "Email", "Email verified", "Cheque First Name",
    "Cheque Last Name", "Address 1", "Address 2", "City/Town", "Zip code",
    "Account Number", "Bank Sort Code", "PayPal account", "Retailer", "Store",
    "Purchase Date (UTC)", "Purchase Date (store)", "Receipt ID", "Product Purchased", "Number of Products Purchased",
    "Purchase Price", "Country", "Currency", "Value", "Pay Type", "Comment", "Consumer ID",
  ]);

  // Data rows
  for (const row of rows) {
    ws.addRow(row);
  }

  const buf = await wb.xlsx.writeBuffer() as Buffer;
  return buf;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ZIP-surgical processor: new row appending", () => {
  it("appends new rows and skips duplicates", async () => {
    // Master has one existing row with serial "SERIAL001"
    const existingRow = [
      "SERIAL001", "2024-01-01", "2024-01-02", "USER001", "Alice", "Smith",
      "alice@test.com", "1 Main St", "", "London", "SW1A 1AA",
      "12345678", "20-00-00", "", "", "",
      "Tesco", "London Bridge", "2024-01-01", "RCPT001", "Product A",
      "10.00", "5.00", "BACS", "", "CONS001", "UK", "GBP",
    ];
    const masterBuf = await buildMasterXlsm([existingRow]);

    // Weekly file has SERIAL001 (duplicate) and SERIAL002 (new)
    const weeklyRows: (string | number)[][] = [
      // Columns: Serial, Submitted(UTC), Updated(UTC), Validated(UTC), Invalidated(UTC),
      // PaymentApproved(UTC), ValidUntil(UTC), State, UserID, Title,
      // FirstName, LastName, Email, EmailVerified, ChequeFirstName,
      // ChequeLastName, Address1, Address2, City/Town, Zipcode,
      // AccountNumber, BankSortCode, PayPalAccount, Retailer, Store,
      // PurchaseDate(UTC), PurchaseDate(store), ReceiptID, ProductPurchased, NumProducts,
      // PurchasePrice, Country, Currency, Value, PayType, Comment, ConsumerID
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

    const result = await processPaymentFiles(masterBuf, "SC_Johnson_Master.xlsm", weeklyBuf, "extractedSCJ.xlsx");

    expect(result.rowsAdded).toBe(1);
    expect(result.rowsSkipped).toBe(1);
    expect(result.sheetResults).toHaveLength(1);

    const ukResult = result.sheetResults[0];
    expect(ukResult.sheetName).toBe("UK");
    expect(ukResult.rowsAdded).toBe(1);
    expect(ukResult.rowsSkipped).toBe(1);

    // Verify the output ZIP contains the new row
    // New rows are stored using shared strings (t="s"), so check the SST
    const outZip = await JSZip.loadAsync(result.updatedMasterBuffer);
    const sstXml = await outZip.file("xl/sharedStrings.xml")!.async("string");
    expect(sstXml).toContain("SERIAL002");
    expect(sstXml).toContain("Bob");
  }, 30000);

  it("returns zero rows added when all are duplicates", async () => {
    const existingRow = [
      "SERIAL001", "2024-01-01", "2024-01-02", "USER001", "Alice", "Smith",
      "alice@test.com", "1 Main St", "", "London", "SW1A 1AA",
      "12345678", "20-00-00", "", "", "",
      "Tesco", "London Bridge", "2024-01-01", "RCPT001", "Product A",
      "10.00", "5.00", "BACS", "", "CONS001", "UK", "GBP",
    ];
    const masterBuf = await buildMasterXlsm([existingRow]);

    const weeklyRows: (string | number)[][] = [[
      // Serial, Submitted(UTC), Updated(UTC), Validated(UTC), Invalidated(UTC),
      // PaymentApproved(UTC), ValidUntil(UTC), State, UserID, Title,
      // FirstName, LastName, Email, EmailVerified, ChequeFirstName,
      // ChequeLastName, Address1, Address2, City/Town, Zipcode,
      // AccountNumber, BankSortCode, PayPalAccount, Retailer, Store,
      // PurchaseDate(UTC), PurchaseDate(store), ReceiptID, ProductPurchased, NumProducts,
      // PurchasePrice, Country, Currency, Value, PayType, Comment, ConsumerID
      "SERIAL001", "2024-01-01", "", "2024-01-02", "", "", "", "", "USER001", "",
      "Alice", "Smith", "alice@test.com", "", "", "",
      "1 Main St", "", "London", "SW1A 1AA",
      "12345678", "20-00-00", "", "Tesco", "London Bridge",
      "2024-01-01", "", "RCPT001", "Product A", "",
      "10.00", "UK", "GBP", "5.00", "BACS", "", "CONS001",
    ]];
    const weeklyBuf = await buildWeeklyXlsx(weeklyRows);

    const result = await processPaymentFiles(masterBuf, "SC_Johnson_Master.xlsm", weeklyBuf, "extractedSCJ.xlsx");

    expect(result.rowsAdded).toBe(0);
    expect(result.rowsSkipped).toBe(1);
  }, 30000);
});
