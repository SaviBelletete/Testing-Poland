/**
 * Diagnostic script: load the weekly file with ExcelJS and report what the parser sees.
 * Usage: node scripts/diagnose-weekly.mjs /path/to/weekly.xlsx
 */
import ExcelJS from "exceljs";
import { readFileSync } from "fs";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/diagnose-weekly.mjs <path-to-xlsx>");
  process.exit(1);
}

const buf = readFileSync(filePath);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

console.log(`\n=== Workbook sheets (${wb.worksheets.length}) ===`);
for (const ws of wb.worksheets) {
  console.log(`\nSheet: "${ws.name}"  rowCount=${ws.rowCount}  columnCount=${ws.columnCount}`);

  // Row 1 — title
  const row1 = ws.getRow(1);
  const r1vals = [];
  row1.eachCell((c) => r1vals.push(String(c.value ?? "").trim()));
  console.log(`  Row 1 (title): ${r1vals.slice(0, 5).join(" | ")}`);

  // Row 2 — headers
  const headerMap = new Map();
  const row2 = ws.getRow(2);
  row2.eachCell((cell, colNum) => {
    const h = String(cell.value ?? "").trim();
    if (h) headerMap.set(h, colNum);
  });
  console.log(`  Row 2 headers (${headerMap.size}): ${[...headerMap.keys()].slice(0, 10).join(", ")}`);
  console.log(`  Key headers: Serial=${headerMap.get("Serial")}, "Pay Type"=${headerMap.get("Pay Type")}, Value=${headerMap.get("Value")}, "Account Number"=${headerMap.get("Account Number")}`);

  // Data rows
  let dataRows = 0;
  let emptySerials = 0;
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const serialIdx = headerMap.get("Serial");
    const serial = serialIdx ? String(row.getCell(serialIdx).value ?? "").trim() : "";
    if (serial) {
      dataRows++;
      if (dataRows <= 3) {
        const payTypeIdx = headerMap.get("Pay Type");
        const valueIdx = headerMap.get("Value");
        const payType = payTypeIdx ? String(row.getCell(payTypeIdx).value ?? "").trim() : "N/A";
        const value = valueIdx ? row.getCell(valueIdx).value : "N/A";
        console.log(`  Row ${r}: serial="${serial}" payType="${payType}" value=${value}`);
      }
    } else {
      emptySerials++;
    }
  }
  console.log(`  Data rows with serial: ${dataRows}, rows with empty serial: ${emptySerials}`);
}
