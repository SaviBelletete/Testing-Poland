import { writeFileSync } from "fs";
import { createRequire } from "module";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "../.env") });

const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");

const FORGE_URL = (process.env.BUILT_IN_FORGE_API_URL || "").replace(/\/+$/, "");
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const STORAGE_KEY = "masters/1780997073097_Nomad_Master_8b39e650.xlsm";

if (!FORGE_URL || !FORGE_KEY) {
  console.error("Missing BUILT_IN_FORGE_API_URL or BUILT_IN_FORGE_API_KEY");
  process.exit(1);
}

// Get presigned GET URL
const getUrl = new URL("v1/storage/presign/get", FORGE_URL + "/");
getUrl.searchParams.set("path", STORAGE_KEY);

const signedRes = await fetch(getUrl, {
  headers: { Authorization: `Bearer ${FORGE_KEY}` },
});

if (!signedRes.ok) {
  console.error("Failed to get signed URL:", signedRes.status, await signedRes.text());
  process.exit(1);
}

const { url } = await signedRes.json();
console.log("Got signed URL, downloading...");

const fileRes = await fetch(url);
if (!fileRes.ok) {
  console.error("Failed to download:", fileRes.status);
  process.exit(1);
}

const buf = Buffer.from(await fileRes.arrayBuffer());
console.log("Downloaded:", buf.length, "bytes, first bytes:", buf.slice(0, 4).toString("hex"));
writeFileSync("/tmp/nomad_master.xlsm", buf);

// Inspect with ExcelJS
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf);

console.log("\nAll sheets:", wb.worksheets.map(ws => `"${ws.name}" (rows: ${ws.rowCount})`).join(", "));

// Check France and Portugal specifically
for (const sheetName of ["France", "Portugal", " France", " Portugal"]) {
  const ws = wb.getWorksheet(sheetName);
  if (ws) {
    console.log(`\nSheet "${sheetName}": rowCount=${ws.rowCount}, actualRowCount=${ws.actualRowCount}`);
    for (let r = 1; r <= Math.min(4, ws.rowCount); r++) {
      const row = ws.getRow(r);
      const vals = [];
      row.eachCell({ includeEmpty: false }, (cell) => vals.push(`${cell.address}=${JSON.stringify(cell.value)}`));
      if (vals.length > 0) console.log(`  Row ${r}:`, vals.slice(0, 6).join(", "));
    }
  } else {
    console.log(`\nSheet "${sheetName}": NOT FOUND`);
  }
}
