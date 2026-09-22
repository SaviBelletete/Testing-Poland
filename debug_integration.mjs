import JSZip from "jszip";
import ExcelJS from "exceljs";

// ─── Build test master ───────────────────────────────────────────────────────

function buildSst(strings) {
  const items = strings.map(s => `<si><t>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

function buildSheetXml(headerRow, dataRows) {
  const rows = [];
  const headerCells = headerRow.map((v, i) => {
    const col = String.fromCharCode(65 + i);
    return `<c r="${col}1" t="inlineStr"><is><t>${v}</t></is></c>`;
  }).join("");
  rows.push(`<row r="1">${headerCells}</row>`);

  dataRows.forEach((row, ri) => {
    const rowNum = ri + 2;
    const cells = row.map((v, ci) => {
      const col = String.fromCharCode(65 + ci);
      if (v === "") return `<c r="${col}${rowNum}"/>`;
      return `<c r="${col}${rowNum}" t="inlineStr"><is><t>${v}</t></is></c>`;
    }).join("");
    rows.push(`<row r="${rowNum}">${cells}</row>`);
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

async function buildMasterXlsm(existingRows) {
  const zip = new JSZip();

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`);

  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="UK" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`);

  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`);

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

  return await zip.generateAsync({ type: "nodebuffer" });
}

async function buildWeeklyXlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("UK");
  ws.addRow(["Weekly Payment Extract"]);
  ws.addRow([
    "Serial", "Submitted (UTC)", "col3", "Validated (UTC)", "col5",
    "col6", "col7", "col8", "User ID", "col10",
    "First Name", "Last Name", "Email", "col14", "col15",
    "col16", "Address 1", "Address 2", "City/Town", "Zip code",
    "Account Number", "Bank Sort Code", "PayPal account", "Retailer", "Store",
    "Purchase Date", "col27", "Receipt ID", "Product Purchased", "col30",
    "Purchase Price", "Country", "Currency", "Value", "Pay Type", "Comment", "Consumer ID",
  ]);
  for (const row of rows) ws.addRow(row);
  return await wb.xlsx.writeBuffer();
}

// ─── Debug ───────────────────────────────────────────────────────────────────

const existingRow = [
  "SERIAL001", "2024-01-01", "2024-01-02", "USER001", "Alice", "Smith",
  "alice@test.com", "1 Main St", "", "London", "SW1A 1AA",
  "12345678", "20-00-00", "", "", "",
  "Tesco", "London Bridge", "2024-01-01", "RCPT001", "Product A",
  "10.00", "5.00", "BACS", "", "CONS001", "UK", "GBP",
];

const masterBuf = await buildMasterXlsm([existingRow]);
console.log("Master ZIP built, size:", masterBuf.length);

// Check ZIP contents
const zip = await JSZip.loadAsync(masterBuf);
console.log("ZIP files:", Object.keys(zip.files));

const workbookXml = await zip.file("xl/workbook.xml").async("string");
console.log("workbook.xml:", workbookXml);

const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
console.log("rels.xml:", relsXml);

// Parse sheet map
const ridToPath = new Map();
const relRe = /<Relationship[^>]+Id="([^"]+)"[^>]+Target="([^"]+)"[^>]*\/?>/g;
let rm;
while ((rm = relRe.exec(relsXml)) !== null) {
  ridToPath.set(rm[1], rm[2]);
}
console.log("ridToPath:", Object.fromEntries(ridToPath));

const sheetRe = /<sheet[^>]+name="([^"]+)"[^>]+r:id="([^"]+)"[^>]*\/?>/g;
let sm;
const sheetMap = new Map();
while ((sm = sheetRe.exec(workbookXml)) !== null) {
  const name = sm[1];
  const rid = sm[2];
  const target = ridToPath.get(rid);
  if (target) {
    const path = target.startsWith("worksheets/") ? `xl/${target}` : `xl/worksheets/${target}`;
    sheetMap.set(name.toLowerCase(), path);
    sheetMap.set(name, path);
  }
}
console.log("sheetMap:", Object.fromEntries(sheetMap));

// Check if UK sheet file exists
const ukPath = sheetMap.get("uk") || sheetMap.get("UK");
console.log("UK sheet path:", ukPath);
console.log("UK sheet file exists:", !!zip.file(ukPath));

// Build weekly
const weeklyRows = [
  ["SERIAL001", "2024-01-01", "", "2024-01-02", "", "", "", "", "USER001", "", "Alice", "Smith", "alice@test.com", "", "", "", "1 Main St", "", "London", "SW1A 1AA", "12345678", "20-00-00", "", "Tesco", "London Bridge", "2024-01-01", "", "RCPT001", "Product A", "", "10.00", "UK", "GBP", "5.00", "BACS", "", "CONS001"],
  ["SERIAL002", "2024-01-08", "", "2024-01-09", "", "", "", "", "USER002", "", "Bob", "Jones", "bob@test.com", "", "", "", "2 High St", "", "Manchester", "M1 1AA", "87654321", "30-00-00", "", "Asda", "Manchester", "2024-01-08", "", "RCPT002", "Product B", "", "20.00", "UK", "GBP", "8.00", "BACS", "", "CONS002"],
];
const weeklyBuf = await buildWeeklyXlsx(weeklyRows);
console.log("Weekly XLSX built, size:", weeklyBuf.length, "type:", weeklyBuf.constructor.name);

// Load weekly with ExcelJS
const weeklyWb = new ExcelJS.Workbook();
const weeklyArrayBuffer = weeklyBuf.buffer.slice(weeklyBuf.byteOffset, weeklyBuf.byteOffset + weeklyBuf.byteLength);
await weeklyWb.xlsx.load(weeklyArrayBuffer);
console.log("Weekly sheets:", weeklyWb.worksheets.map(s => s.name));

const weeklySheet = weeklyWb.getWorksheet("UK");
console.log("Weekly UK sheet found:", !!weeklySheet);
console.log("Weekly UK row count:", weeklySheet?.rowCount);

// Check header map
const headerMap = new Map();
const headerRow = weeklySheet?.getRow(2);
headerRow?.eachCell((cell, colNum) => {
  const header = String(cell.value ?? "").trim();
  if (header) headerMap.set(header, colNum);
});
console.log("Header map size:", headerMap.size);
console.log("Serial col:", headerMap.get("Serial"));
