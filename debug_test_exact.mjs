import JSZip from "jszip";
import ExcelJS from "exceljs";

// Exactly mimic the test's buildWeeklyXlsx
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
  const buf = await wb.xlsx.writeBuffer();
  return buf;
}

const weeklyRows = [
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
console.log("weeklyBuf type:", weeklyBuf.constructor.name, "size:", weeklyBuf.length);

// Now load it exactly as processPaymentFiles does
const weeklyWb = new ExcelJS.Workbook();
let weeklyArrayBuffer;
if (weeklyBuf instanceof ArrayBuffer) {
  weeklyArrayBuffer = weeklyBuf;
} else {
  weeklyArrayBuffer = weeklyBuf.buffer.slice(
    weeklyBuf.byteOffset,
    weeklyBuf.byteOffset + weeklyBuf.byteLength
  );
}
await weeklyWb.xlsx.load(weeklyArrayBuffer);

console.log("Sheets:", weeklyWb.worksheets.map(s => s.name));

// Iterate sheets as processPaymentFiles does
for (const weeklySheet of weeklyWb.worksheets) {
  console.log("\nSheet:", weeklySheet.name, "rowCount:", weeklySheet.rowCount);
  
  // Row 1 = title, row 2 = headers
  const headerMap = new Map();
  const headerRow = weeklySheet.getRow(2);
  console.log("Row 2 values:", headerRow.values);
  headerRow.eachCell((cell, colNum) => {
    const header = String(cell.value ?? "").trim();
    if (header) headerMap.set(header, colNum);
  });
  
  console.log("headerMap size:", headerMap.size);
  console.log("Serial col:", headerMap.get("Serial"));
  
  // Try row 3
  const row3 = weeklySheet.getRow(3);
  console.log("Row 3 values:", row3.values);
}
