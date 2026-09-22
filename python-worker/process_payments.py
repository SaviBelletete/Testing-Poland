#!/usr/bin/env python3
"""
Payment File Processor - Python Worker
Uses a ZIP-surgical approach for large .xlsm files:
- Reads the target sheet XML directly from the ZIP archive
- Appends new rows to the XML
- Repackages the ZIP without loading the entire workbook into memory
Runs as a Flask microservice on port 5001.
"""
import os
import io
import json
import re
import zipfile
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime
from flask import Flask, request, jsonify, send_file
import openpyxl

app = Flask(__name__)

# ─── Namespaces ───────────────────────────────────────────────────────────────

NS = {
    'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006',
    'x14ac': 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac',
}

# Register namespaces to avoid ns0: prefixes
for prefix, uri in NS.items():
    ET.register_namespace(prefix if prefix != 'main' else '', uri)

ET.register_namespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
ET.register_namespace('mc', 'http://schemas.openxmlformats.org/markup-compatibility/2006')
ET.register_namespace('x14ac', 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac')

# ─── Client Detection ─────────────────────────────────────────────────────────

def detect_client(weekly_filename: str, master_filename: str, master_sheet_names: list) -> str:
    combined = (weekly_filename + " " + master_filename).lower()
    if any(k in combined for k in ["scj", "sc_johnson", "sc johnson", "johnson"]):
        return "SC Johnson"
    if any(k in combined for k in ["pepsi", "pepsico"]):
        return "PepsiCo"
    for s in master_sheet_names:
        if "johnson" in s.lower():
            return "SC Johnson"
        if "pepsi" in s.lower():
            return "PepsiCo"
    return "Unknown"

# ─── Sheet Detection ──────────────────────────────────────────────────────────

COUNTRY_MAP = {
    "pl": ["poland"],
    "poland": ["poland"],
    "fr": ["france"],
    "france": ["france"],
    "de": ["germany"],
    "germany": ["germany"],
    "uk": ["uk", "united kingdom"],
    "gb": ["uk", "united kingdom"],
    "it": ["italy"],
    "italy": ["italy"],
    "nl": ["netherlands"],
    "netherlands": ["netherlands"],
    "se": ["sweden"],
    "sweden": ["sweden"],
    "ch": ["switzerland"],
    "switzerland": ["switzerland"],
    "za": ["south africa"],
    "south africa": ["south africa"],
    "tr": ["turkey"],
    "turkey": ["turkey"],
    "arkusz1": ["poland", "france", "uk"],
    "sheet1": ["poland", "france", "uk"],
}

def detect_target_sheet(weekly_sheet: str, master_sheets: list) -> str | None:
    norm = weekly_sheet.strip().lower()
    for ms in master_sheets:
        if ms.strip().lower() == norm:
            return ms
    for ms in master_sheets:
        if norm in ms.strip().lower() or ms.strip().lower() in norm:
            return ms
    aliases = COUNTRY_MAP.get(norm, [])
    for alias in aliases:
        for ms in master_sheets:
            if alias in ms.strip().lower():
                return ms
    return None

# ─── ZIP Helpers ──────────────────────────────────────────────────────────────

def get_sheet_names_from_zip(zf: zipfile.ZipFile) -> list[str]:
    """Get ordered sheet names from workbook.xml."""
    with zf.open('xl/workbook.xml') as f:
        tree = ET.parse(f)
    root = tree.getroot()
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    sheets = root.find(f'{{{ns}}}sheets')
    if sheets is None:
        return []
    return [s.get('name', '') for s in sheets.findall(f'{{{ns}}}sheet')]

def get_sheet_rid(zf: zipfile.ZipFile, sheet_name: str) -> str | None:
    """Get the relationship ID for a sheet by name."""
    with zf.open('xl/workbook.xml') as f:
        tree = ET.parse(f)
    root = tree.getroot()
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    sheets = root.find(f'{{{ns}}}sheets')
    if sheets is None:
        return None
    for s in sheets.findall(f'{{{ns}}}sheet'):
        if s.get('name') == sheet_name:
            return s.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
    return None

def get_sheet_path(zf: zipfile.ZipFile, rid: str) -> str | None:
    """Get the file path for a sheet given its relationship ID."""
    with zf.open('xl/_rels/workbook.xml.rels') as f:
        tree = ET.parse(f)
    root = tree.getroot()
    ns = 'http://schemas.openxmlformats.org/package/2006/relationships'
    for rel in root.findall(f'{{{ns}}}Relationship'):
        if rel.get('Id') == rid:
            target = rel.get('Target', '')
            if not target.startswith('xl/'):
                target = 'xl/' + target
            return target
    return None

def get_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    """Load shared strings table."""
    if 'xl/sharedStrings.xml' not in zf.namelist():
        return []
    with zf.open('xl/sharedStrings.xml') as f:
        tree = ET.parse(f)
    root = tree.getroot()
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    strings = []
    for si in root.findall(f'{{{ns}}}si'):
        t = si.find(f'{{{ns}}}t')
        if t is not None and t.text:
            strings.append(t.text)
        else:
            # Rich text
            parts = []
            for r_elem in si.findall(f'{{{ns}}}r'):
                t2 = r_elem.find(f'{{{ns}}}t')
                if t2 is not None and t2.text:
                    parts.append(t2.text)
            strings.append(''.join(parts))
    return strings

def col_letter_to_num(col_str: str) -> int:
    """Convert column letter(s) to 1-based number."""
    num = 0
    for c in col_str.upper():
        num = num * 26 + (ord(c) - ord('A') + 1)
    return num

def num_to_col_letter(n: int) -> str:
    """Convert 1-based column number to letter(s)."""
    result = ''
    while n > 0:
        n, remainder = divmod(n - 1, 26)
        result = chr(65 + remainder) + result
    return result

def cell_ref_to_row_col(ref: str):
    """Parse cell ref like 'AB12' -> (col_num, row_num)."""
    m = re.match(r'^(\$?[A-Za-z]+)(\$?\d+)$', ref)
    if not m:
        return None, None
    col_str = m.group(1).replace('$', '')
    row_str = m.group(2).replace('$', '')
    return col_letter_to_num(col_str), int(row_str)

def get_cell_value_from_xml(cell_elem, shared_strings: list):
    """Extract the value from a cell XML element."""
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    t = cell_elem.get('t', '')  # type
    v_elem = cell_elem.find(f'{{{ns}}}v')
    if v_elem is None or v_elem.text is None:
        return None
    val = v_elem.text
    if t == 's':
        # Shared string
        try:
            return shared_strings[int(val)]
        except (IndexError, ValueError):
            return val
    elif t == 'b':
        return val == '1'
    elif t == 'str' or t == 'inlineStr':
        return val
    else:
        # Number or date
        try:
            f = float(val)
            return int(f) if f == int(f) else f
        except ValueError:
            return val

# ─── Weekly File Parser (using openpyxl read-only) ───────────────────────────

def parse_weekly_file(wb: openpyxl.Workbook, sheet_name: str = None):
    """Parse weekly file. Row 1 = title, Row 2 = headers, Row 3+ = data."""
    if sheet_name and sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
    else:
        ws = None
        for s in wb.worksheets:
            if s.max_row and s.max_row > 2:
                ws = s
                break
        if ws is None:
            ws = wb.worksheets[0]

    used_sheet_name = ws.title

    # Row 2 = headers
    headers = {}
    for cell in ws[2]:
        if cell.value:
            headers[str(cell.value).strip()] = cell.column

    def col(*names):
        for n in names:
            if n in headers:
                return headers[n]
        return None

    def get_val(row_cells, col_idx):
        if col_idx is None:
            return None
        for cell in row_cells:
            if cell.column == col_idx:
                v = cell.value
                if v is None:
                    return None
                if isinstance(v, (int, float)):
                    return v
                return str(v).strip()
        return None

    def get_date(row_cells, col_idx):
        if col_idx is None:
            return None
        for cell in row_cells:
            if cell.column == col_idx:
                v = cell.value
                if v is None:
                    return None
                if isinstance(v, datetime):
                    return v
                if isinstance(v, str) and v.strip():
                    try:
                        return datetime.fromisoformat(v.strip())
                    except:
                        return None
        return None

    rows = []
    for row in ws.iter_rows(min_row=3, values_only=False):
        serial_col = col("Serial")
        serial_val = None
        for cell in row:
            if cell.column == serial_col:
                serial_val = cell.value
                break
        if not serial_val:
            continue

        rows.append({
            "serial": str(serial_val).strip(),
            "submitted": get_date(row, col("Submitted (UTC)", "Submitted")),
            "validated": get_date(row, col("Validated (UTC)", "Validated")),
            "userId": get_val(row, col("User ID")),
            "firstName": get_val(row, col("First Name")) or "",
            "lastName": get_val(row, col("Last Name")) or "",
            "email": get_val(row, col("Email")) or "",
            "address1": get_val(row, col("Address 1")) or "",
            "address2": get_val(row, col("Address 2")) or "",
            "cityTown": get_val(row, col("City/Town")) or "",
            "zipCode": get_val(row, col("Zip code")) or "",
            "accountNumber": get_val(row, col("Account Number")) or "",
            "bankSortCode": get_val(row, col("Bank Sort Code")) or "",
            "paypalAccount": get_val(row, col("PayPal account")) or "",
            "retailer": get_val(row, col("Retailer")) or "",
            "store": get_val(row, col("Store")) or "",
            "purchaseDate": get_date(row, col("Purchase Date (UTC)", "Purchase Date (store)", "Purchase Date")),
            "receiptId": get_val(row, col("Receipt ID")) or "",
            "productPurchased": get_val(row, col("Product Purchased")) or "",
            "purchasePrice": float(get_val(row, col("Purchase Price")) or 0),
            "value": float(get_val(row, col("Value")) or 0),
            "payType": get_val(row, col("Pay Type")) or "",
            "comment": get_val(row, col("Comment")) or "",
            "consumerId": get_val(row, col("Consumer ID")) or "",
            "country": get_val(row, col("Country")) or "",
            "currency": get_val(row, col("Currency")) or "",
        })

    return rows, used_sheet_name, wb.sheetnames

# ─── Read existing serials from sheet XML ────────────────────────────────────

def get_existing_serials_and_last_row(zf: zipfile.ZipFile, sheet_path: str,
                                       shared_strings: list) -> tuple[set, int, int]:
    """Read existing serial numbers and find last data row from sheet XML."""
    with zf.open(sheet_path) as f:
        content = f.read()

    root = ET.fromstring(content)
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

    # Find header row to locate serial column
    sheet_data = root.find(f'{{{ns}}}sheetData')
    if sheet_data is None:
        return set(), 0, 1

    serial_col = 1  # default A
    existing_serials = set()
    last_data_row = 1
    opp_number = ""

    for row_elem in sheet_data.findall(f'{{{ns}}}row'):
        row_num = int(row_elem.get('r', 0))
        if row_num == 1:
            # Header row - find serial column
            for cell in row_elem.findall(f'{{{ns}}}c'):
                ref = cell.get('r', '')
                col_num, _ = cell_ref_to_row_col(ref)
                val = get_cell_value_from_xml(cell, shared_strings)
                if val and str(val).strip().lower() == 'serial':
                    serial_col = col_num
                    break
            continue

        # Data rows
        for cell in row_elem.findall(f'{{{ns}}}c'):
            ref = cell.get('r', '')
            col_num, _ = cell_ref_to_row_col(ref)
            if col_num == serial_col:
                val = get_cell_value_from_xml(cell, shared_strings)
                if val:
                    existing_serials.add(str(val).strip())
                    last_data_row = row_num
            if col_num == 52 and row_num == 2:
                val = get_cell_value_from_xml(cell, shared_strings)
                if val:
                    opp_number = str(val)

    return existing_serials, last_data_row, serial_col

# ─── Build new row XML ────────────────────────────────────────────────────────

def date_to_excel_serial(dt: datetime) -> float:
    """Convert datetime to Excel serial number."""
    if dt is None:
        return None
    # Excel epoch is 1900-01-01, with a leap year bug (1900-02-29 doesn't exist)
    epoch = datetime(1899, 12, 30)
    delta = dt - epoch
    return delta.days + delta.seconds / 86400

def make_cell_xml(col_num: int, row_num: int, value, cell_type: str = None,
                  number_format: str = None) -> str:
    """Build a cell XML string."""
    ref = f"{num_to_col_letter(col_num)}{row_num}"
    if value is None or value == "":
        return f'<c r="{ref}"/>'

    if isinstance(value, str):
        # Inline string
        escaped = value.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')
        return f'<c r="{ref}" t="inlineStr"><is><t>{escaped}</t></is></c>'
    elif isinstance(value, datetime):
        serial = date_to_excel_serial(value)
        if serial is None:
            return f'<c r="{ref}"/>'
        # Use date number format (14 = mm/dd/yyyy)
        return f'<c r="{ref}" s="1"><v>{serial:.10f}</v></c>'
    elif isinstance(value, (int, float)):
        return f'<c r="{ref}"><v>{value}</v></c>'
    elif isinstance(value, bool):
        return f'<c r="{ref}" t="b"><v>{"1" if value else "0"}</v></c>'
    else:
        escaped = str(value).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        return f'<c r="{ref}" t="inlineStr"><is><t>{escaped}</t></is></c>'

def make_formula_cell_xml(col_num: int, row_num: int, formula: str) -> str:
    """Build a formula cell XML string."""
    ref = f"{num_to_col_letter(col_num)}{row_num}"
    escaped = formula.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    return f'<c r="{ref}"><f>{escaped}</f></c>'

def build_row_xml(row_num: int, weekly_row: dict, opportunity_number: str,
                  client_name: str, template_formulas: dict) -> str:
    """Build the complete XML for a new data row."""
    r = row_num
    acct = weekly_row["accountNumber"]
    is_sepa = len(acct) > 10 and acct[:2].isalpha() and acct[:2].isupper()
    is_bank = weekly_row["payType"].lower() == "bank" or is_sepa

    cells = []

    def add(col_num, value):
        cells.append(make_cell_xml(col_num, r, value))

    def add_formula(col_num, formula):
        cells.append(make_formula_cell_xml(col_num, r, formula))

    # A-AB: Data columns
    add(1, weekly_row["serial"])
    add(2, weekly_row["submitted"])
    add(3, weekly_row["validated"])
    add(4, weekly_row["userId"] or None)
    add(5, weekly_row["firstName"])
    add(6, weekly_row["lastName"])
    add(7, weekly_row["email"])
    add(8, weekly_row["address1"] or None)
    add(9, weekly_row["address2"] or None)
    add(10, weekly_row["cityTown"] or None)
    add(11, weekly_row["zipCode"] or None)
    add(12, None if is_bank else (weekly_row["accountNumber"] or None))
    add(13, None if is_bank else (weekly_row["bankSortCode"] or None))
    add(14, weekly_row["accountNumber"] if is_bank else None)
    add(15, weekly_row["bankSortCode"] if is_bank else None)
    add(16, weekly_row["paypalAccount"] or None)
    add(17, weekly_row["retailer"] or None)
    add(18, weekly_row["store"] or None)
    add(19, weekly_row["purchaseDate"])
    add(20, weekly_row["receiptId"] or None)
    add(21, weekly_row["productPurchased"] or None)
    add(22, weekly_row["purchasePrice"] or None)
    add(23, weekly_row["value"])
    add(24, weekly_row["payType"] or None)
    add(25, weekly_row["comment"] or None)
    add(26, weekly_row["consumerId"] or None)
    add(27, weekly_row["country"] or None)
    add(28, weekly_row["currency"] or None)
    add(29, None)  # Invoice Date
    add(30, None)  # Date Paid

    # AE-AX (31-50): Formula columns
    if template_formulas:
        for col_num in range(31, 51):
            if col_num in template_formulas:
                formula = template_formulas[col_num]
                cells.append(make_formula_cell_xml(col_num, r, formula))
    else:
        # Default formulas
        formulas = {
            31: f'IF(L{r}="","",RIGHT(L{r},LEN(L{r})-1))',
            32: f'SUBSTITUTE(M{r},"-","")',
            33: f'IF(AF{r}="","",LEFT(TRIM(AF{r}),2)&"-"&MID(AF{r},3,2)&"-"&RIGHT(AF{r},2))',
            34: f'IF(N{r}="","",N{r})',
            35: f'IF(C{r}="","",LEFT(TRIM(C{r}),3))',
            36: f'IF(C{r}="","",MID(C{r},5,2))',
            38: f'E{r}&" "&F{r}',
            39: f'IF(P{r}<>0,P{r}," ")',
            40: f'IF(AL{r}=" "," ","{client_name}")',
            41: f'IF(AL{r}=" "," ","Private")',
            42: f'AB{r}',
            43: f'IF(W{r}>0,W{r}," ")',
            44: f'IF(AL{r}=" "," ","EUR")',
            45: f'AP{r}',
            46: f'AH{r}',
            47: f'IF(AT{r}="","  ",O{r})',
            50: f'IF(AW{r}="","",AQ{r}/AW{r})',
        }
        for col_num, formula in formulas.items():
            cells.append(make_formula_cell_xml(col_num, r, formula))

    add(51, None)  # Comments
    add(52, opportunity_number or None)

    # Filter out empty cells
    non_empty = [c for c in cells if c != f'<c r="{num_to_col_letter(cells.index(c)+1)}{r}"/>']

    cells_xml = ''.join(cells)
    return f'<row r="{r}">{cells_xml}</row>'

def get_template_formulas(zf: zipfile.ZipFile, sheet_path: str,
                          last_data_row: int, shared_strings: list) -> dict:
    """Extract formula patterns from the last data row."""
    if last_data_row <= 1:
        return {}

    with zf.open(sheet_path) as f:
        content = f.read()

    root = ET.fromstring(content)
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    sheet_data = root.find(f'{{{ns}}}sheetData')
    if sheet_data is None:
        return {}

    formulas = {}
    for row_elem in sheet_data.findall(f'{{{ns}}}row'):
        row_num = int(row_elem.get('r', 0))
        if row_num != last_data_row:
            continue
        for cell in row_elem.findall(f'{{{ns}}}c'):
            ref = cell.get('r', '')
            col_num, _ = cell_ref_to_row_col(ref)
            if col_num is None or col_num < 31 or col_num > 50:
                continue
            f_elem = cell.find(f'{{{ns}}}f')
            if f_elem is not None and f_elem.text:
                formulas[col_num] = f_elem.text
        break

    return formulas

# ─── Surgical ZIP modification ────────────────────────────────────────────────

def append_rows_to_sheet_xml(sheet_xml: bytes, new_rows_xml: list[str]) -> bytes:
    """Append new row XML strings to the sheetData element."""
    content = sheet_xml.decode('utf-8')

    # Find the closing </sheetData> tag and insert before it
    insert_pos = content.rfind('</sheetData>')
    if insert_pos == -1:
        # No sheetData closing tag - try to find <sheetData/> and expand it
        sd_pos = content.find('<sheetData/>')
        if sd_pos != -1:
            rows_str = ''.join(new_rows_xml)
            content = content[:sd_pos] + f'<sheetData>{rows_str}</sheetData>' + content[sd_pos+12:]
        else:
            raise ValueError("Could not find sheetData in sheet XML")
    else:
        rows_str = ''.join(new_rows_xml)
        content = content[:insert_pos] + rows_str + content[insert_pos:]

    return content.encode('utf-8')

def process_xlsm_surgical(master_bytes: bytes, weekly_rows: list,
                           target_sheet: str, opportunity_number: str,
                           client_name: str) -> tuple:
    """Process the master file using surgical ZIP modification."""
    with zipfile.ZipFile(io.BytesIO(master_bytes), 'r') as zf:
        # Get sheet path
        rid = get_sheet_rid(zf, target_sheet)
        if not rid:
            raise ValueError(f"Sheet '{target_sheet}' not found in workbook relationships")

        sheet_path = get_sheet_path(zf, rid)
        if not sheet_path:
            raise ValueError(f"Could not resolve path for sheet '{target_sheet}'")

        # Load shared strings
        shared_strings = get_shared_strings(zf)

        # Get existing serials and last row
        existing_serials, last_data_row, serial_col = get_existing_serials_and_last_row(
            zf, sheet_path, shared_strings
        )

        # Get template formulas from last data row
        template_formulas = get_template_formulas(zf, sheet_path, last_data_row, shared_strings)

        # Get opportunity number from existing data if not provided
        if not opportunity_number:
            # Already extracted during get_existing_serials_and_last_row
            pass

        # Build new rows
        rows_added = 0
        rows_skipped = 0
        skipped_serials = []
        added_amount_total = 0.0
        new_rows_xml = []

        for weekly_row in weekly_rows:
            if weekly_row["serial"] in existing_serials:
                skipped_serials.append(weekly_row["serial"])
                rows_skipped += 1
                continue

            new_row_num = last_data_row + rows_added + 1

            # Adjust template formulas for new row number
            adjusted_formulas = {}
            for col_num, formula in template_formulas.items():
                new_formula = re.sub(
                    r'(\$?[A-Za-z]+)' + str(last_data_row) + r'(?!\d)',
                    lambda m, nr=new_row_num: m.group(1) + str(nr),
                    formula
                )
                adjusted_formulas[col_num] = new_formula

            row_xml = build_row_xml(
                new_row_num, weekly_row, opportunity_number,
                client_name, adjusted_formulas
            )
            new_rows_xml.append(row_xml)
            rows_added += 1
            added_amount_total += weekly_row["value"]
            existing_serials.add(weekly_row["serial"])

        if rows_added == 0:
            # No changes needed - return original
            return io.BytesIO(master_bytes), 0, rows_skipped, skipped_serials, 0.0

        # Read original sheet XML
        with zf.open(sheet_path) as f:
            original_sheet_xml = f.read()

        # Append new rows
        updated_sheet_xml = append_rows_to_sheet_xml(original_sheet_xml, new_rows_xml)

        # Rebuild ZIP with updated sheet
        output_buf = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(master_bytes), 'r') as zf_in, \
             zipfile.ZipFile(output_buf, 'w', zipfile.ZIP_DEFLATED) as zf_out:
            for item in zf_in.infolist():
                if item.filename == sheet_path:
                    zf_out.writestr(item, updated_sheet_xml)
                else:
                    zf_out.writestr(item, zf_in.read(item.filename))

        output_buf.seek(0)
        return output_buf, rows_added, rows_skipped, skipped_serials, added_amount_total

# ─── API Endpoints ────────────────────────────────────────────────────────────

def run_processing(weekly_file, master_file, weekly_sheet_hint=None, master_sheet_override=None):
    """Core processing logic shared between endpoints."""
    # Parse weekly file
    weekly_wb = openpyxl.load_workbook(io.BytesIO(weekly_file.read()), data_only=True)
    weekly_rows, parsed_sheet, weekly_sheets = parse_weekly_file(weekly_wb, weekly_sheet_hint)
    # Get master sheet names from ZIP (fast, no full load)
    master_bytes = master_file.read()
    with zipfile.ZipFile(io.BytesIO(master_bytes), 'r') as zf:
        master_sheets = get_sheet_names_from_zip(zf)
    # Detect client and target sheet
    client_name = detect_client(weekly_file.filename, master_file.filename, master_sheets)
    if master_sheet_override and master_sheet_override in master_sheets:
        target_sheet = master_sheet_override
    else:
        target_sheet = detect_target_sheet(parsed_sheet, master_sheets)
    if not target_sheet:
        raise ValueError(
            f'Could not find matching sheet for "{parsed_sheet}". '
            f'Master has: {", ".join(master_sheets)}'
        )

    # Get opportunity number from master sheet
    opportunity_number = ""
    with zipfile.ZipFile(io.BytesIO(master_bytes), 'r') as zf:
        shared_strings = get_shared_strings(zf)
        rid = get_sheet_rid(zf, target_sheet)
        if rid:
            sheet_path = get_sheet_path(zf, rid)
            if sheet_path:
                with zf.open(sheet_path) as f:
                    content = f.read()
                root = ET.fromstring(content)
                ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
                sheet_data = root.find(f'{{{ns}}}sheetData')
                if sheet_data:
                    for row_elem in sheet_data.findall(f'{{{ns}}}row'):
                        if int(row_elem.get('r', 0)) == 2:
                            for cell in row_elem.findall(f'{{{ns}}}c'):
                                ref = cell.get('r', '')
                                col_num, _ = cell_ref_to_row_col(ref)
                                if col_num == 52:
                                    val = get_cell_value_from_xml(cell, shared_strings)
                                    if val:
                                        opportunity_number = str(val)
                            break

    # Process
    weekly_amount_total = sum(r["value"] for r in weekly_rows)
    output_buf, rows_added, rows_skipped, skipped_serials, added_amount_total = process_xlsm_surgical(
        master_bytes, weekly_rows, target_sheet, opportunity_number, client_name
    )

    # Reconciliation
    skipped_amount = sum(r["value"] for r in weekly_rows if r["serial"] in skipped_serials)
    row_count_match = (len(weekly_rows) - rows_skipped) == rows_added
    if rows_added == 0:
        amount_match = True
    else:
        expected = weekly_amount_total - skipped_amount
        amount_match = abs(added_amount_total - expected) < 0.01

    result = {
        "clientName": client_name,
        "sheetName": target_sheet,
        "weeklyFile": weekly_file.filename,
        "masterFile": master_file.filename,
        "rowsInWeekly": len(weekly_rows),
        "rowsAdded": rows_added,
        "rowsSkipped": rows_skipped,
        "skippedSerials": skipped_serials,
        "reconciliation": {
            "rowCountMatch": row_count_match,
            "amountMatch": amount_match,
            "weeklyRowCount": len(weekly_rows),
            "addedRowCount": rows_added,
            "weeklyAmountTotal": round(weekly_amount_total, 2),
            "addedAmountTotal": round(added_amount_total, 2),
        },
        "success": True,
    }

    return result, output_buf, master_file.filename


@app.route("/process", methods=["POST"])
def process():
    weekly_file = request.files.get("weeklyFile")
    master_file = request.files.get("masterFile")
    weekly_sheet = request.form.get("weeklySheet")
    master_sheet = request.form.get("masterSheet") or request.form.get("targetSheet")
    if not weekly_file or not master_file:
        return jsonify({"error": "weeklyFile and masterFile are required"}), 400
    try:
        result, output_buf, original_filename = run_processing(weekly_file, master_file, weekly_sheet, master_sheet)
        # Return result + base64 file
        import base64
        file_b64 = base64.b64encode(output_buf.read()).decode('utf-8')
        return jsonify({
            "result": result,
            "filename": original_filename,
            "fileBase64": file_b64,
        })
    except ValueError as e:
        return jsonify({"error": str(e)}), 422
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/process-download", methods=["POST"])
def process_download():
    weekly_file = request.files.get("weeklyFile")
    master_file = request.files.get("masterFile")
    weekly_sheet = request.form.get("weeklySheet")
    master_sheet = request.form.get("masterSheet") or request.form.get("targetSheet")
    if not weekly_file or not master_file:
        return jsonify({"error": "weeklyFile and masterFile are required"}), 400
    try:
        result, output_buf, original_filename = run_processing(weekly_file, master_file, weekly_sheet, master_sheet)
        return send_file(
            output_buf,
            as_attachment=True,
            download_name=original_filename,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ), 200, {"X-Result": json.dumps(result)}
    except ValueError as e:
        return jsonify({"error": str(e)}), 422
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/detect", methods=["POST"])
def detect():
    """Detect client name and available sheets from a master file."""
    master_file = request.files.get("masterFile")
    if not master_file:
        return jsonify({"error": "masterFile is required"}), 400
    try:
        master_bytes = master_file.read()
        with zipfile.ZipFile(io.BytesIO(master_bytes), 'r') as zf:
            sheet_names = get_sheet_names_from_zip(zf)
        client_name = detect_client("", master_file.filename, sheet_names)
        # Pick the most likely target sheet (first non-RDB sheet)
        target_sheet = ""
        for s in sheet_names:
            sl = s.lower()
            if any(k in sl for k in ["poland", "france", "uk", "germany", "spain", "italy", "arkusz"]):
                target_sheet = s
                break
        if not target_sheet and sheet_names:
            # Skip sheets that look like system/merge sheets
            for s in sheet_names:
                if "rdb" not in s.lower() and "merge" not in s.lower():
                    target_sheet = s
                    break
        if not target_sheet and sheet_names:
            target_sheet = sheet_names[0]
        return jsonify({
            "clientName": client_name,
            "sheetName": target_sheet,
            "sheetNames": sheet_names,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PYTHON_WORKER_PORT", 5001))
    app.run(host="127.0.0.1", port=port, debug=False)
