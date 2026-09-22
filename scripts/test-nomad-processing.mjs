/**
 * Run processPaymentFiles against the real Nomad master and weekly file,
 * then inspect the output ZIP to check France and Portugal sheets.
 */
import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "../.env") });

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");

// Dynamically import the compiled TS via tsx
const { processPaymentFiles } = await import("../server/paymentProcessor.ts");

const masterBuf = readFileSync("/tmp/nomad_master.xlsm");
const weeklyBuf = readFileSync("/home/ubuntu/upload/CashbackClaims090626.xlsx");

console.log("Running processPaymentFiles...");
const result = await processPaymentFiles(
  masterBuf,
  "Nomad_Master.xlsm",
  weeklyBuf,
  "CashbackClaims090626.xlsx"
);

console.log("\n=== Sheet Results ===");
for (const sr of result.sheetResults) {
  console.log(`${sr.sheetName}: in=${sr.rowsInWeekly} added=${sr.rowsAdded} skipped=${sr.rowsSkipped}`);
}

console.log("\n=== Checking output France and Portugal sheets ===");
const outputBuf = result.updatedMasterBuffer;
console.log("Output buffer:", outputBuf.length, "bytes, magic:", outputBuf.slice(0, 4).toString("hex"));
writeFileSync("/tmp/nomad_updated.xlsm", outputBuf);

// Open the output ZIP and inspect France/Portugal sheets
const zip = new AdmZip(outputBuf);
const workbookXml = zip.readAsText("xl/workbook.xml");

// Find France and Portugal sheet paths
const sheetEntries = workbookXml.matchAll(/<sheet[^>]+name="([^"]+)"[^>]+r:id="([^"]+)"/g);
const sheetRIds = {};
for (const m of sheetEntries) {
  sheetRIds[m[1]] = m[2];
}
console.log("Sheets in workbook:", Object.keys(sheetRIds).join(", "));

const relsXml = zip.readAsText("xl/_rels/workbook.xml.rels");
const relPaths = {};
for (const m of relsXml.matchAll(/Id="([^"]+)"[^>]+Target="([^"]+)"/g)) {
  relPaths[m[1]] = m[2];
}

for (const sheetName of ["France", "Portugal"]) {
  const rId = sheetRIds[sheetName];
  if (!rId) { console.log(`\n${sheetName}: not found in workbook`); continue; }
  const relPath = relPaths[rId];
  if (!relPath) { console.log(`\n${sheetName}: no rel path for rId ${rId}`); continue; }
  
  const fullPath = relPath.startsWith("worksheets/") ? `xl/${relPath}` : `xl/worksheets/${relPath}`;
  const sheetXml = zip.readAsText(fullPath);
  
  // Count rows
  const rowMatches = Array.from(sheetXml.matchAll(/<row r="(\d+)"/g));
  const rowNums = rowMatches.map(m => parseInt(m[1]));
  const maxRow = rowNums.length > 0 ? Math.max(...rowNums) : 0;
  
  console.log(`\n${sheetName} (${fullPath}): ${rowNums.length} row elements, max row=${maxRow}`);
  
  // Check if </sheetData> appears multiple times
  const sheetDataCloseCount = (sheetXml.match(/<\/sheetData>/g) || []).length;
  console.log(`  </sheetData> count: ${sheetDataCloseCount}`);
  
  // Show last 200 chars of sheetData section
  const sheetDataEnd = sheetXml.indexOf("</sheetData>");
  if (sheetDataEnd > 0) {
    console.log(`  Around </sheetData>:`, JSON.stringify(sheetXml.slice(Math.max(0, sheetDataEnd - 100), sheetDataEnd + 20)));
  }
}
