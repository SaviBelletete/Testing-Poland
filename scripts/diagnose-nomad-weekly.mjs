import { readFileSync } from "fs";
import { createRequire } from "module";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "../.env") });

const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");

// Step 1: Load the master from the local file we already downloaded
const masterBuf = readFileSync("/tmp/nomad_master.xlsm");
const weeklyBuf = readFileSync("/home/ubuntu/upload/CashbackClaims090626.xlsx");

console.log("Master:", masterBuf.length, "bytes");
console.log("Weekly:", weeklyBuf.length, "bytes");

// Step 2: Read all serial numbers from the master France and Portugal sheets
const masterWb = new ExcelJS.Workbook();
await masterWb.xlsx.load(masterBuf);

const masterSerials = {};
for (const sheetName of ["France", "Portugal"]) {
  const ws = masterWb.getWorksheet(sheetName);
  if (!ws) { console.log(`Master sheet "${sheetName}" not found`); continue; }
  const serials = new Set();
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return; // skip header
    const serial = String(row.getCell(1).value || "").trim();
    if (serial) serials.add(serial);
  });
  masterSerials[sheetName] = serials;
  console.log(`\nMaster "${sheetName}": ${serials.size} existing serials`);
}

// Step 3: Read the weekly file and check France/Portugal rows
const weeklyWb = new ExcelJS.Workbook();
await weeklyWb.xlsx.load(weeklyBuf);

console.log("\nWeekly sheets:", weeklyWb.worksheets.map(ws => `"${ws.name}"`).join(", "));

// Check each weekly sheet for France/Portugal matches
for (const ws of weeklyWb.worksheets) {
  const name = ws.name.trim();
  const normName = name.toLowerCase().replace(/[^a-z]/g, "");
  
  const isFrance = normName.includes("france") || normName === "fr";
  const isPortugal = normName.includes("portugal") || normName === "pt";
  
  if (!isFrance && !isPortugal) continue;
  
  const masterSheetName = isFrance ? "France" : "Portugal";
  const existingSerials = masterSerials[masterSheetName] || new Set();
  
  console.log(`\nWeekly sheet "${ws.name}" → maps to master "${masterSheetName}"`);
  console.log(`  rowCount: ${ws.rowCount}, actualRowCount: ${ws.actualRowCount}`);
  
  // Find header row
  let headerRow = null;
  let headerRowNum = 0;
  ws.eachRow((row, rowNum) => {
    if (headerRow) return;
    const firstCell = String(row.getCell(1).value || "").trim().toLowerCase();
    if (firstCell === "serial" || firstCell === "serial number" || firstCell.includes("serial")) {
      headerRow = row;
      headerRowNum = rowNum;
    }
  });
  
  if (!headerRow) {
    console.log("  No header row found!");
    // Print first 3 rows to debug
    ws.eachRow((row, rowNum) => {
      if (rowNum > 3) return;
      const vals = [];
      row.eachCell({ includeEmpty: false }, (cell) => vals.push(`${cell.address}=${JSON.stringify(cell.value)}`));
      console.log(`  Row ${rowNum}:`, vals.slice(0, 6).join(", "));
    });
    continue;
  }
  
  console.log(`  Header row: ${headerRowNum}`);
  
  let newRows = 0;
  let dupRows = 0;
  const newSerials = [];
  const dupSerials = [];
  
  ws.eachRow((row, rowNum) => {
    if (rowNum <= headerRowNum) return;
    const serial = String(row.getCell(1).value || "").trim();
    if (!serial) return;
    if (existingSerials.has(serial)) {
      dupRows++;
      dupSerials.push(serial);
    } else {
      newRows++;
      newSerials.push(serial);
    }
  });
  
  console.log(`  New rows: ${newRows}, Duplicate rows: ${dupRows}`);
  if (newSerials.length > 0) {
    console.log(`  New serials:`, newSerials.slice(0, 5));
  }
  if (dupSerials.length > 0) {
    console.log(`  Dup serials (first 5):`, dupSerials.slice(0, 5));
  }
}
