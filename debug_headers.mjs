import ExcelJS from "exceljs";

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("UK");

// Row 1: title
ws.addRow(["Weekly Payment Extract"]);

// Row 2: headers
ws.addRow([
  "Serial", "Submitted (UTC)", "col3", "Validated (UTC)", "col5",
  "col6", "col7", "col8", "User ID", "col10",
  "First Name", "Last Name", "Email", "col14", "col15",
  "col16", "Address 1", "Address 2", "City/Town", "Zip code",
  "Account Number", "Bank Sort Code", "PayPal account", "Retailer", "Store",
  "Purchase Date", "col27", "Receipt ID", "Product Purchased", "col30",
  "Purchase Price", "Country", "Currency", "Value", "Pay Type", "Comment", "Consumer ID",
]);

// Data row
ws.addRow([
  "SERIAL002", "2024-01-08", "", "2024-01-09", "", "", "", "", "USER002", "",
  "Bob", "Jones", "bob@test.com", "", "", "",
  "2 High St", "", "Manchester", "M1 1AA",
  "87654321", "30-00-00", "", "Asda", "Manchester",
  "2024-01-08", "", "RCPT002", "Product B", "",
  "20.00", "UK", "GBP", "8.00", "BACS", "", "CONS002",
]);

const buf = await wb.xlsx.writeBuffer();
console.log("Buffer type:", buf.constructor.name, "instanceof ArrayBuffer:", buf instanceof ArrayBuffer);

// Now reload it and check headers
const wb2 = new ExcelJS.Workbook();
if (buf instanceof ArrayBuffer) {
  await wb2.xlsx.load(buf);
} else {
  await wb2.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const ws2 = wb2.getWorksheet("UK");
console.log("Sheet found:", !!ws2);
console.log("Row count:", ws2?.rowCount);

const row1 = ws2?.getRow(1);
const row2 = ws2?.getRow(2);
const row3 = ws2?.getRow(3);

console.log("Row 1 values:", row1?.values);
console.log("Row 2 values:", row2?.values);
console.log("Row 3 values:", row3?.values);

// Build header map
const headerMap = new Map();
row2?.eachCell((cell, colNum) => {
  const header = String(cell.value ?? "").trim();
  if (header) headerMap.set(header, colNum);
});
console.log("Header map:", Object.fromEntries(headerMap));
console.log("Serial col:", headerMap.get("Serial"));
