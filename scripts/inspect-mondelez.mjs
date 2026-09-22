import ExcelJS from 'exceljs';

async function inspect() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('/home/ubuntu/upload/Mondelez_Master.xlsm');
  
  const countrySheets = ['France', 'Germany', 'Spain', 'UK', 'Italy'];
  
  for (const sheetName of countrySheets) {
    const sheet = wb.getWorksheet(sheetName);
    if (!sheet) { console.log(`${sheetName}: NOT FOUND`); continue; }
    
    console.log(`\n=== ${sheetName} ===`);
    console.log(`rowCount: ${sheet.rowCount}, actualRowCount: ${sheet.actualRowCount}`);
    
    // Print row 1
    const row1 = sheet.getRow(1);
    const headers = [];
    row1.eachCell((cell, colNum) => {
      headers.push(`C${colNum}=${JSON.stringify(cell.value)}`);
    });
    console.log('Row 1:', headers.slice(0, 8).join(', '));
    
    // Print row 2
    const row2 = sheet.getRow(2);
    const r2vals = [];
    row2.eachCell((cell, colNum) => {
      r2vals.push(`C${colNum}=${JSON.stringify(cell.value)}`);
    });
    console.log('Row 2:', r2vals.slice(0, 5).join(', '));
  }
  
  // Also check if the processor can parse it - look for Serial Number column
  const france = wb.getWorksheet('France');
  if (france) {
    const row1 = france.getRow(1);
    let serialCol = -1;
    row1.eachCell((cell, colNum) => {
      const val = String(cell.value || '').toLowerCase();
      if (val.includes('serial') || val.includes('claim') || val.includes('id')) {
        serialCol = colNum;
        console.log(`\nFound potential serial column at C${colNum}: ${cell.value}`);
      }
    });
  }
}

inspect().catch(console.error);
