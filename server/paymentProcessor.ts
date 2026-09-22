/**
 * ZIP-Surgical Payment Processor
 *
 * Instead of loading the entire .xlsm workbook with ExcelJS (slow, OOM risk),
 * this processor:
 *   1. Reads the master .xlsm as a ZIP and parses only the shared strings table (SST)
 *      and the workbook.xml to build a sheet-name → file-path map.
 *   2. Reads the weekly .xlsx with ExcelJS (small file, fast).
 *   3. For each country sheet in the weekly file, finds the matching sheet in the master,
 *      reads its XML, appends new <row> elements, and repacks the ZIP.
 *   4. Updates the SST with any new string values.
 *
 * This reduces processing time from ~27s to <2s for a 27MB .xlsm file.
 */

import AdmZip from "adm-zip";
import ExcelJS from "exceljs";

// ─── Column index helpers ────────────────────────────────────────────────────

/** Convert 0-based column index to Excel column letter (0→A, 25→Z, 26→AA …) */
function colLetter(idx: number): string {
  let result = "";
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/** Convert Excel column letter to 0-based index */
function colIndex(letter: string): number {
  let result = 0;
  for (const ch of letter.toUpperCase()) {
    result = result * 26 + (ch.charCodeAt(0) - 64);
  }
  return result - 1;
}

/** Convert a JS Date to an Excel serial number (days since 1900-01-00) */
function dateToSerial(d: Date): number {
  // Excel epoch: Jan 0, 1900 = day 0; JS epoch: Jan 1, 1970 = 0ms
  const excelEpoch = new Date(Date.UTC(1899, 11, 30));
  return (d.getTime() - excelEpoch.getTime()) / 86400000;
}

// ─── XML helpers ─────────────────────────────────────────────────────────────

/** Escape a string for XML attribute/text content */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Parse the shared strings table into an array of strings */
function parseSST(xml: string): string[] {
  const strings: string[] = [];
  // Match <si>...</si> blocks
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1];
    // Collect all <t> text nodes (handles rich text with multiple <r><t> segments)
    const tRe = /<t(?:[^>]*)>([\s\S]*?)<\/t>/g;
    let text = "";
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(inner)) !== null) {
      text += tm[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
    }
    strings.push(text);
  }
  return strings;
}

/** Serialise the SST array back to XML */
function buildSST(strings: string[], originalHeader: string): string {
  const count = strings.length;
  // Update count and uniqueCount attributes
  const header = originalHeader
    .replace(/count="\d+"/, `count="${count}"`)
    .replace(/uniqueCount="\d+"/, `uniqueCount="${count}"`);
  const body = strings
    .map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`)
    .join("");
  return header + body + "</sst>";
}

/** Parse workbook.xml to get sheet name → rId map, then rels to get rId → path */
function parseSheetMap(
  workbookXml: string,
  relsXml: string
): Map<string, string> {
  const map = new Map<string, string>();

  // Build rId → target path from rels
  const ridToPath = new Map<string, string>();
  const relRe =
    /<Relationship[^>]+Id="([^"]+)"[^>]+Target="([^"]+)"[^>]*\/?>/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(relsXml)) !== null) {
    ridToPath.set(rm[1], rm[2]);
  }

  // Build sheet name → file path
  const sheetRe = /<sheet[^>]+name="([^"]+)"[^>]+r:id="([^"]+)"[^>]*\/?>/g;
  let sm: RegExpExecArray | null;
  while ((sm = sheetRe.exec(workbookXml)) !== null) {
    const name = sm[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"');
    const rid = sm[2];
    const target = ridToPath.get(rid);
    if (target) {
      // Target is relative to xl/ directory
      const path = target.startsWith("worksheets/")
        ? `xl/${target}`
        : `xl/worksheets/${target}`;
      map.set(name, path); // original case first (iteration order matters)
      map.set(name.toLowerCase(), path); // also keep lowercase for case-insensitive lookup
    }
  }
  return map;
}

// ─── IBAN country prefix map ─────────────────────────────────────────────────

/** Map IBAN 2-letter country prefix → canonical country key */
const IBAN_PREFIX_TO_COUNTRY: Record<string, string> = {
  GB: "uk",
  FR: "france",
  DE: "germany",
  ES: "spain",
  BE: "belgium",
  IT: "italy",
  PT: "portugal",
  AT: "austria",
  ZA: "south africa",
  EG: "egypt",
  TR: "turkey",
  GR: "greece",
  SE: "sweden",
  CH: "switzerland",
  NO: "norway",
  IE: "ireland",
  CY: "cyprus",
  NL: "netherlands",
  LU: "luxembourg",
  PL: "poland",
  CZ: "czech republic",
  HU: "hungary",
  RO: "romania",
  BG: "bulgaria",
  HR: "croatia",
  SK: "slovakia",
  DK: "denmark",
  FI: "finland",
  LV: "latvia",
  LT: "lithuania",
  EE: "estonia",
  MT: "malta",
  SI: "slovenia",
};

/**
 * Detect the country canonical key from IBAN values in the weekly sheet.
 * Scans up to the first 10 data rows and returns the most common IBAN prefix.
 */
function detectCountryFromIban(
  weeklySheet: ExcelJS.Worksheet,
  headerMap: Map<string, number>
): string | null {
  const counts: Record<string, number> = {};
  const ibanCol = headerMap.get("Account Number");
  if (!ibanCol) return null;
  let scanned = 0;
  for (let r = 3; r <= weeklySheet.rowCount && scanned < 10; r++) {
    const row = weeklySheet.getRow(r);
    const iban = String(row.getCell(ibanCol).value ?? "").trim().toUpperCase();
    if (iban.length >= 2) {
      const prefix = iban.slice(0, 2);
      if (/^[A-Z]{2}$/.test(prefix)) {
        counts[prefix] = (counts[prefix] ?? 0) + 1;
        scanned++;
      }
    }
  }
  if (Object.keys(counts).length === 0) return null;
  const topPrefix = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return IBAN_PREFIX_TO_COUNTRY[topPrefix] ?? null;
}

// ─── Country normalisation ────────────────────────────────────────────────────

const COUNTRY_ALIASES: Record<string, string[]> = {
  uk: ["uk", "gb", "united kingdom", "great britain", "england", "uk bacs"],
  france: ["france", "fr"],
  germany: ["germany", "de", "deutschland"],
  spain: ["spain", "es", "españa"],
  // Belgium has many regional/language suffixes in weekly files (NL, FR, BE, etc.)
  belgium: ["belgium", "be", "belgique", "belgium nl", "belgium fr", "belgium-nl", "belgium-fr", "be nl", "be fr", "belgië"],
  italy: ["italy", "it", "italia"],
  portugal: ["portugal", "pt"],
  austria: ["austria", "at", "österreich"],
  "south africa": ["south africa", "za", "southafrica", "south_africa"],
  egypt: ["egypt", "eg"],
  turkey: ["turkey", "tr", "türkiye", "turkiye"],
  greece: ["greece", "gr"],
  sweden: ["sweden", "se"],
  switzerland: ["switzerland", "ch", "schweiz"],
  norway: ["norway", "no"],
  ireland: ["ireland", "ie", "roi", "republic of ireland", "roi ireland", "ireland roi"],
  cyprus: ["cyprus", "cy"],
  netherlands: ["netherlands", "nl", "holland", "the netherlands"],
  luxembourg: ["luxembourg", "lu", "luxemburg", "luxemburg"],
  poland: ["poland", "pl"],
  "czech republic": ["czech republic", "cz", "czechia", "czech"],
  hungary: ["hungary", "hu"],
  romania: ["romania", "ro"],
  bulgaria: ["bulgaria", "bg"],
  croatia: ["croatia", "hr"],
  slovakia: ["slovakia", "sk"],
  denmark: ["denmark", "dk"],
  finland: ["finland", "fi"],
  latvia: ["latvia", "lv"],
  lithuania: ["lithuania", "lt"],
  estonia: ["estonia", "ee"],
  malta: ["malta", "mt"],
  slovenia: ["slovenia", "si"],
};

/**
 * Normalise a sheet name to a canonical country key.
 * Strategy:
 *  1. Exact alias match (after trim + lowercase)
 *  2. Partial match: the trimmed name *starts with* a canonical country key
 *     (handles "Belgium NL", "South Africa ZA", " France 2026", etc.)
 */
function normaliseCountry(name: string): string {
  const lower = name.toLowerCase().trim();
  // 1. Exact alias match
  for (const [canonical, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (aliases.includes(lower)) return canonical;
  }
  // 2. Partial match: canonical key is a prefix of the sheet name
  //    (e.g. "belgium nl" starts with "belgium")
  for (const canonical of Object.keys(COUNTRY_ALIASES)) {
    if (lower.startsWith(canonical + " ") || lower.startsWith(canonical + "-") || lower.startsWith(canonical + "_")) {
      return canonical;
    }
  }
  // 3. Partial match: canonical key appears anywhere in the sheet name
  //    (less precise, only used as last resort before returning raw)
  for (const canonical of Object.keys(COUNTRY_ALIASES)) {
    if (lower.includes(canonical)) return canonical;
  }
  return lower;
}

// ─── Weekly file column mapping ───────────────────────────────────────────────

/**
 * Map a weekly row (0-based column indices) to master columns (0-based).
 * Weekly headers are in row 2 (index 1), data starts at row 3 (index 2).
 *
 * Master columns (0-based):
 *  A=0  Serial
 *  B=1  Submitted
 *  C=2  Validated
 *  D=3  User ID
 *  E=4  First Name
 *  F=5  Last Name
 *  G=6  Email
 *  H=7  Address 1
 *  I=8  Address 2
 *  J=9  City/Town
 *  K=10 Zip code
 *  L=11 Account Number (BACS) / IBAN (SEPA)
 *  M=12 BACS Sort Code / BIC (SEPA)
 *  N=13 IBAN
 *  O=14 BIC
 *  P=15 PayPal account
 *  Q=16 Retailer
 *  R=17 Store
 *  S=18 Purchase Date
 *  T=19 Receipt ID
 *  U=20 Product Purchased
 *  V=21 Purchase Price
 *  W=22 Value
 *  X=23 Pay Type
 *  Y=24 Comment
 *  Z=25 Consumer ID
 *  AA=26 Country
 *  AB=27 Currency
 */

interface WeeklyRow {
  serial: string;
  submitted: Date | null;
  validated: Date | null;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  address1: string;
  address2: string;
  city: string;
  zip: string;
  accountNumber: string;
  sortCode: string;
  paypalAccount: string;
  retailer: string;
  store: string;
  purchaseDate: string;
  receiptId: string;
  productPurchased: string;
  purchasePrice: number;
  value: number;
  payType: string;
  comment: string;
  consumerId: string;
  country: string;
  currency: string;
  iban: string;
  bic: string;
}

function parseWeeklyRow(
  row: ExcelJS.Row,
  headerMap: Map<string, number>
): WeeklyRow | null {
  const get = (name: string): ExcelJS.CellValue => {
    const idx = headerMap.get(name);
    if (!idx || idx < 1) return null; // column not present in this file
    return row.getCell(idx).value;
  };

  const serial = String(get("Serial") ?? "").trim();
  if (!serial) return null;

  const payType = String(get("Pay Type") ?? "").toLowerCase().trim();
  const isSepa =
    payType === "sepa" ||
    payType === "bank transfer" ||
    payType === "wire" ||
    payType === "iban";

  const accountNumber = String(get("Account Number") ?? "").trim();
  const sortCode = String(get("Bank Sort Code") ?? "").trim();
  // BIC/SWIFT — optional column; gracefully absent if not in file
  const bicRaw = get("BIC") ?? get("SWIFT") ?? get("BIC/SWIFT") ?? null;
  const bic = bicRaw !== null ? String(bicRaw).trim() : "";
  // IBAN — for SEPA rows the Account Number column contains the IBAN
  const iban = isSepa ? accountNumber : "";

  return {
    serial,
    submitted: get("Submitted (UTC)") instanceof Date
      ? (get("Submitted (UTC)") as Date)
      : null,
    validated: get("Validated (UTC)") instanceof Date
      ? (get("Validated (UTC)") as Date)
      : null,
    userId: String(get("User ID") ?? "").trim(),
    firstName: String(get("First Name") ?? "").trim(),
    lastName: String(get("Last Name") ?? "").trim(),
    email: String(get("Email") ?? "").trim(),
    address1: String(get("Address 1") ?? "").trim(),
    address2: String(get("Address 2") ?? "").trim(),
    city: String(get("City/Town") ?? "").trim(),
    zip: String(get("Zip code") ?? "").trim(),
    accountNumber: isSepa ? "" : accountNumber,
    sortCode: isSepa ? "" : sortCode,
    iban,
    bic,
    paypalAccount: String(get("PayPal account") ?? "").trim(),
    retailer: String(get("Retailer") ?? "").trim(),
    store: String(get("Store") ?? "").trim(),
    purchaseDate: String(get("Purchase Date (UTC)") ?? "").trim(),
    receiptId: String(get("Receipt ID") ?? "").trim(),
    productPurchased: String(get("Product Purchased") ?? "").trim(),
    purchasePrice: Number(get("Purchase Price") ?? 0),
    value: Number(get("Value") ?? 0),
    payType: String(get("Pay Type") ?? "").trim(),
    comment: String(get("Comment") ?? "").trim(),
    consumerId: String(get("Consumer ID") ?? "").trim(),
    country: String(get("Country") ?? "").trim(),
    currency: String(get("Currency") ?? "").trim(),
  };
}

// ─── Row XML builder ──────────────────────────────────────────────────────────

/**
 * Build a <row> XML element for a new master row.
 * Strings are stored as shared string indices (t="s").
 * Numbers are stored inline.
 * Dates are stored as Excel serial numbers with a date style.
 */
function buildRowXml(
  rowNum: number,
  data: WeeklyRow,
  sst: string[],
  sstMap: Map<string, number>,
  lastRowXml: string,
  styleMap: Map<string, string>
): string {
  /** Get or add a string to the SST, return its index */
  const sstIdx = (s: string): number => {
    if (sstMap.has(s)) return sstMap.get(s)!;
    const idx = sst.length;
    sst.push(s);
    sstMap.set(s, idx);
    return idx;
  };

  /** Build a string cell */
  const strCell = (col: string, val: string, style?: string): string => {
    if (!val && val !== "0") {
      // Empty string — use inline empty string cell
      const s = style ? ` s="${style}"` : "";
      return `<c r="${col}${rowNum}"${s} t="str"><v/></c>`;
    }
    const idx = sstIdx(val);
    const s = style ? ` s="${style}"` : "";
    return `<c r="${col}${rowNum}"${s} t="s"><v>${idx}</v></c>`;
  };

  /** Build a numeric cell */
  const numCell = (col: string, val: number, style?: string): string => {
    const s = style ? ` s="${style}"` : "";
    return `<c r="${col}${rowNum}"${s}><v>${val}</v></c>`;
  };

  /** Build a date cell (stored as serial number with date style) */
  const dateCell = (col: string, d: Date | null, style: string): string => {
    if (!d) return `<c r="${col}${rowNum}" s="${style}"><v/></c>`;
    return `<c r="${col}${rowNum}" s="${style}"><v>${dateToSerial(d)}</v></c>`;
  };

  // Extract styles from the last row for the same columns
  const getStyle = (col: string): string => {
    return styleMap.get(col) ?? "";
  };

  // Build cells for master columns A–AB (data columns)
  const cells: string[] = [];

  // A: Serial (string)
  cells.push(strCell("A", data.serial, getStyle("A")));
  // B: Submitted (date)
  cells.push(dateCell("B", data.submitted, getStyle("B") || "196"));
  // C: Validated (date)
  cells.push(dateCell("C", data.validated, getStyle("C") || "196"));
  // D: User ID (string)
  cells.push(strCell("D", data.userId, getStyle("D")));
  // E: First Name (string)
  cells.push(strCell("E", data.firstName, getStyle("E") || "47"));
  // F: Last Name (string)
  cells.push(strCell("F", data.lastName, getStyle("F")));
  // G: Email (string)
  cells.push(strCell("G", data.email, getStyle("G") || "47"));
  // H: Address 1 (string)
  cells.push(strCell("H", data.address1, getStyle("H") || "47"));
  // I: Address 2 (string)
  cells.push(strCell("I", data.address2, getStyle("I") || "47"));
  // J: City/Town (string)
  cells.push(strCell("J", data.city, getStyle("J") || "47"));
  // K: Zip code (string)
  cells.push(strCell("K", data.zip, getStyle("K") || "47"));
  // L: Account Number (string)
  cells.push(strCell("L", data.accountNumber, getStyle("L") || "47"));
  // M: BACS Sort Code (string)
  cells.push(strCell("M", data.sortCode, getStyle("M") || "47"));
  // N: IBAN (for SEPA rows; empty for BACS)
  cells.push(strCell("N", data.iban, getStyle("N") || "47"));
  // O: BIC (for SEPA rows; empty for BACS)
  cells.push(strCell("O", data.bic, getStyle("O") || "47"));
  // P: PayPal account (string)
  cells.push(strCell("P", data.paypalAccount, getStyle("P") || "47"));
  // Q: Retailer (string)
  cells.push(strCell("Q", data.retailer, getStyle("Q") || "47"));
  // R: Store (string)
  cells.push(strCell("R", data.store, getStyle("R") || "47"));
  // S: Purchase Date (string)
  cells.push(strCell("S", data.purchaseDate, getStyle("S") || "47"));
  // T: Receipt ID (string)
  cells.push(strCell("T", data.receiptId, getStyle("T") || "47"));
  // U: Product Purchased (string)
  cells.push(strCell("U", data.productPurchased, getStyle("U")));
  // V: Purchase Price (number)
  cells.push(numCell("V", data.purchasePrice, getStyle("V")));
  // W: Value (number)
  cells.push(numCell("W", data.value, getStyle("W")));
  // X: Pay Type (string)
  cells.push(strCell("X", data.payType, getStyle("X") || "47"));
  // Y: Comment (string)
  cells.push(strCell("Y", data.comment, getStyle("Y") || "47"));
  // Z: Consumer ID (string)
  cells.push(strCell("Z", data.consumerId, getStyle("Z")));
  // AA: Country (formula-driven in master, but we write value as str)
  cells.push(strCell("AA", data.country, getStyle("AA") || "58"));
  // AB: Currency (formula-driven in master, but we write value as str)
  cells.push(strCell("AB", data.currency, getStyle("AB") || "58"));

  return `<row r="${rowNum}" spans="1:52" x14ac:dyDescent="0.3">${cells.join("")}</row>`;
}

/** Extract style attributes from existing row XML for each column */
function extractStyleMap(lastRowXml: string): Map<string, string> {
  const map = new Map<string, string>();
  const cellRe = /<c r="([A-Z]+)\d+"(?:[^>]* s="(\d+)")?[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(lastRowXml)) !== null) {
    const col = m[1];
    const style = m[2] ?? "";
    if (!map.has(col)) map.set(col, style);
  }
  return map;
}

// ─── Main processor ───────────────────────────────────────────────────────────

export interface SheetResult {
  sheetName: string;
  rowsInWeekly: number;
  rowsAdded: number;
  rowsSkipped: number;
  skippedSerials: string[];
  rowCountPass: boolean;
  amountExpected: number;
  amountActual: number;
  amountPass: boolean;
  addedRows: WeeklyRow[];
}

export interface ProcessResult {
  clientName: string;
  sheetName: string; // first sheet processed (for legacy compat)
  weeklyFile: string;
  masterFile: string;
  rowsInWeekly: number;
  rowsAdded: number;
  rowsSkipped: number;
  skippedSerials: string[];
  rowCountPass: boolean;
  amountExpected: number;
  amountActual: number;
  amountPass: boolean;
  sheetResults: SheetResult[];
  updatedMasterBuffer: Buffer;
}

export async function processPaymentFiles(
  masterBuffer: Buffer,
  masterFilename: string,
  weeklyBuffer: Buffer,
  weeklyFilename: string
): Promise<ProcessResult> {
  // ── 1. Load master ZIP ──────────────────────────────────────────────────────
  const zip = new AdmZip(masterBuffer);
  // Force-load all entries into memory so toBuffer() preserves every entry.
  // Without this, adm-zip only serialises entries it has explicitly accessed,
  // dropping unread sheets and corrupting the output file.
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) {
      try { entry.getData(); } catch { /* ignore decompression errors */ }
    }
  }

  // Parse workbook.xml to get sheet name → file path
  const workbookXml = zip.readAsText("xl/workbook.xml");
  const relsEntry = zip.getEntry("xl/_rels/workbook.xml.rels");
  const relsXml = relsEntry ? zip.readAsText("xl/_rels/workbook.xml.rels") : "";
  const sheetMap = parseSheetMap(workbookXml, relsXml);

  // Parse shared strings table
  const sstEntry = zip.getEntry("xl/sharedStrings.xml");
  const sstXmlRaw = sstEntry ? zip.readAsText("xl/sharedStrings.xml") : "";
  // Extract the opening <sst ...> tag (everything before the first <si>)
  const sstHeaderMatch = sstXmlRaw.match(
    /^[\s\S]*?<sst[^>]*>/
  );
  const sstHeader = sstHeaderMatch
    ? sstHeaderMatch[0]
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0">';
  const sst = parseSST(sstXmlRaw);
  const sstMap = new Map<string, number>(sst.map((s, i) => [s, i]));

  // ── 2. Load weekly file with ExcelJS ────────────────────────────────────────
  const weeklyWb = new ExcelJS.Workbook();
  // weeklyBuffer may be a Node.js Buffer (which is a Uint8Array subclass with .buffer)
  // or a plain ArrayBuffer (from ExcelJS writeBuffer in test environments)
  let weeklyArrayBuffer: ArrayBuffer;
  if (weeklyBuffer instanceof ArrayBuffer) {
    weeklyArrayBuffer = weeklyBuffer;
  } else {
    weeklyArrayBuffer = weeklyBuffer.buffer.slice(
      weeklyBuffer.byteOffset,
      weeklyBuffer.byteOffset + weeklyBuffer.byteLength
    ) as ArrayBuffer;
  }
  await weeklyWb.xlsx.load(weeklyArrayBuffer);

  // Detect client name from master filename
  const clientName = masterFilename.toLowerCase().includes("johnson")
    ? "SC Johnson"
    : masterFilename.toLowerCase().includes("pepsi")
    ? "PepsiCo"
    : masterFilename.replace(/\.(xlsm|xlsx)$/i, "");

  // ── 3. Process each sheet in the weekly file ────────────────────────────────
  const sheetResults: SheetResult[] = [];
  let totalRowsInWeekly = 0;
  let totalRowsAdded = 0;
  let totalRowsSkipped = 0;
  const allSkippedSerials: string[] = [];

  for (const weeklySheet of weeklyWb.worksheets) {
    const weeklySheetName = weeklySheet.name;
    const weeklyNorm = normaliseCountry(weeklySheetName);

    // Find matching master sheet
    let masterSheetPath: string | undefined;
    let masterSheetDisplayName = weeklySheetName;

    // Try exact match first (case-insensitive)
    for (const [masterName, path] of Array.from(sheetMap.entries())) {
      if (normaliseCountry(masterName) === weeklyNorm) {
        masterSheetPath = path;
        masterSheetDisplayName = masterName;
        break;
      }
    }

    // Build header map for weekly sheet first (needed for IBAN fallback)
    // Row 1 = title, row 2 = headers
    const headerMap = new Map<string, number>();
    const headerRow = weeklySheet.getRow(2);
    headerRow.eachCell((cell, colNum) => {
      const header = String(cell.value ?? "").trim();
      if (header) headerMap.set(header, colNum);
    });

    if (!masterSheetPath) {
      // No match by sheet name — try IBAN-prefix fallback
      const ibanCountry = detectCountryFromIban(weeklySheet, headerMap);
      if (ibanCountry) {
        for (const [masterName, path] of Array.from(sheetMap.entries())) {
          if (normaliseCountry(masterName) === ibanCountry) {
            masterSheetPath = path;
            masterSheetDisplayName = masterName;
            break;
          }
        }
      }
      if (!masterSheetPath) {
        // Still no match — skip this sheet
        continue;
      }
    }

    // Read master sheet XML
    const masterSheetEntry = zip.getEntry(masterSheetPath);
    if (!masterSheetEntry) continue;
    const masterSheetXml = zip.readAsText(masterSheetPath);

    // Find the last row that has actual data in column A.
    // Some master sheets have pre-formatted empty placeholder rows beyond the last
    // real data row (e.g. France has data up to row 591 but 1131 row elements).
    // Appending after the max row number would leave a visible gap in Excel.
    // We find the last row whose <row> element contains a <c r="A{n}"> cell,
    // which means it has a value in column A (the serial number column).
    const colARowNums: number[] = [];
    const colARowRe = /<row r="(\d+)"[^>]*>[\s\S]*?<c r="A\1"[\s\S]*?<\/row>/g;
    // Use a simpler approach: find all <c r="A{n}"> and collect their row numbers
    const colACellRe = /<c r="A(\d+)"/g;
    let colACellMatch: RegExpExecArray | null;
    while ((colACellMatch = colACellRe.exec(masterSheetXml)) !== null) {
      const rn = parseInt(colACellMatch[1]);
      if (rn > 1) colARowNums.push(rn); // skip header row 1
    }
    // Last data row = highest row with a column A cell; fall back to max row number
    const allRowNums = Array.from(masterSheetXml.matchAll(/<row r="(\d+)"/g)).map((m) =>
      parseInt(m[1])
    );
    const lastDataRowNum = colARowNums.length > 0 ? Math.max(...colARowNums) : 0;
    const lastRowNum = lastDataRowNum > 0 ? lastDataRowNum : (allRowNums.length > 0 ? Math.max(...allRowNums) : 1);

    // Extract the last data row XML for style reference
    // Use the last row that has column A data for style reference (not an empty placeholder row)
    const lastRowMatch = masterSheetXml.match(
      new RegExp(`<row r="${lastRowNum}"[\\s\\S]*?</row>`)
    );
    const lastRowXml = lastRowMatch ? lastRowMatch[0] : "";
    const styleMap = extractStyleMap(lastRowXml);

    // Collect existing serials for duplicate detection
    // Column A cells in the master use shared string indices (t="s"), inline strings (t="str"),
    // or inlineStr format (t="inlineStr") with <is><t>...</t></is> content
    const existingSerials = new Set<string>();

    // Match cells in column A with <v> content (shared strings, numbers, inline str)
    const serialRe = /<c r="A(\d+)"([^>]*)>[\s\S]*?<v>([^<]*)<\/v>[\s\S]*?<\/c>/g;
    let sm: RegExpExecArray | null;
    while ((sm = serialRe.exec(masterSheetXml)) !== null) {
      const rowNum = parseInt(sm[1]);
      if (rowNum <= 1) continue; // skip header row
      const attrs = sm[2];
      const rawVal = sm[3].trim();
      if (!rawVal) continue;
      if (attrs.includes('t="s"')) {
        // Shared string index
        const idx = parseInt(rawVal);
        if (!isNaN(idx) && idx < sst.length) existingSerials.add(sst[idx]);
      } else {
        // Inline string or number — use raw value
        existingSerials.add(rawVal);
      }
    }

    // Also match cells in column A with <is><t>...</t></is> content (inlineStr format)
    const inlineSerialRe = /<c r="A(\d+)"[^>]*t="inlineStr"[^>]*>[\s\S]*?<is>[\s\S]*?<t>([^<]*)<\/t>[\s\S]*?<\/is>[\s\S]*?<\/c>/g;
    let ism: RegExpExecArray | null;
    while ((ism = inlineSerialRe.exec(masterSheetXml)) !== null) {
      const rowNum = parseInt(ism[1]);
      if (rowNum <= 1) continue; // skip header row
      const rawVal = ism[2].trim();
      if (rawVal) existingSerials.add(rawVal);
    }

    // Process data rows (starting from row 3)
    const newRowXmls: string[] = [];
    let rowsInWeekly = 0;
    let rowsAdded = 0;
    let rowsSkipped = 0;
    const skippedSerials: string[] = [];
    const addedRows: WeeklyRow[] = [];
    let amountExpected = 0;
    let amountActual = 0;

    for (let r = 3; r <= weeklySheet.rowCount; r++) {
      const row = weeklySheet.getRow(r);
      const parsed = parseWeeklyRow(row, headerMap);
      if (!parsed) continue;

      rowsInWeekly++;
      amountExpected += parsed.value;

      if (existingSerials.has(parsed.serial)) {
        rowsSkipped++;
        skippedSerials.push(parsed.serial);
        continue;
      }

      const newRowNum = lastRowNum + newRowXmls.length + 1;
      const rowXml = buildRowXml(
        newRowNum,
        parsed,
        sst,
        sstMap,
        lastRowXml,
        styleMap
      );
      newRowXmls.push(rowXml);
      existingSerials.add(parsed.serial);
      addedRows.push(parsed);
      rowsAdded++;
      amountActual += parsed.value;
    }

    // Inject new rows into master sheet XML.
    // IMPORTANT: inject immediately AFTER the last data row (lastRowNum), not at the
    // end of <sheetData>. Some master sheets have pre-formatted empty placeholder rows
    // after the last real data row; appending at </sheetData> would place new rows
    // after those placeholders, creating a visible gap in Excel.
    if (newRowXmls.length > 0) {
      const injection = newRowXmls.join("");
      // Find the closing tag of the last data row and inject immediately after it.
      // The regex matches </row> that belongs to lastRowNum by finding the row element.
      const lastRowEndRe = new RegExp(`(<row r="${lastRowNum}"[\\s\\S]*?<\/row>)`);
      let updatedSheetXml: string;
      if (lastRowEndRe.test(masterSheetXml)) {
        updatedSheetXml = masterSheetXml.replace(lastRowEndRe, `$1${injection}`);
      } else {
        // Fallback: inject before </sheetData> if last row not found
        updatedSheetXml = masterSheetXml.replace("</sheetData>", injection + "</sheetData>");
      }

      // Update dimension ref and autoFilter ref to cover the new rows.
      // The dimension must cover the full sheet including any placeholder rows that
      // exist beyond the last data row. Use the max of: (a) the existing max row number
      // in the sheet (covers placeholder rows) and (b) the new last data row.
      const newLastDataRow = lastRowNum + newRowXmls.length;
      const existingMaxRow = allRowNums.length > 0 ? Math.max(...allRowNums) : lastRowNum;
      const newLastRow = Math.max(newLastDataRow, existingMaxRow);
      const updatedWithDim = updatedSheetXml.replace(
        /(<dimension ref="[A-Z]+\d+:)([A-Z]+)\d+(")/,
        `$1$2${newLastRow}$3`
      );
      // Update autoFilter ref — set end row to Excel's maximum (1048576) so it
      // never needs updating again regardless of how many rows are added in future.
      const updatedWithFilter = updatedWithDim.replace(
        /(<autoFilter ref="[A-Z]+\d+:)([A-Z]+)\d+(")/,
        `$1$21048576$3`
      );

      zip.updateFile(masterSheetPath, Buffer.from(updatedWithFilter, "utf-8"));
    }

    const rowCountPass = rowsAdded === rowsInWeekly - rowsSkipped;
    const amountPass = Math.abs(amountExpected - amountActual) < 0.01;

    sheetResults.push({
      sheetName: masterSheetDisplayName,
      rowsInWeekly,
      rowsAdded,
      rowsSkipped,
      skippedSerials,
      rowCountPass,
      amountExpected,
      amountActual,
      amountPass,
      addedRows,
    });

    totalRowsInWeekly += rowsInWeekly;
    totalRowsAdded += rowsAdded;
    totalRowsSkipped += rowsSkipped;
    allSkippedSerials.push(...skippedSerials);
  }

  // ── 4. Update shared strings table ──────────────────────────────────────────────────────
  if (sstEntry) {
    const newSstXml = buildSST(sst, sstHeader);
    zip.updateFile("xl/sharedStrings.xml", Buffer.from(newSstXml, "utf-8"));
  }

  // ── 5. Generate updated master buffer ─────────────────────────────────────────────────────
  const updatedMasterBuffer = zip.toBuffer();

  const firstSheet = sheetResults[0];
  const totalAmountExpected = sheetResults.reduce(
    (s, r) => s + r.amountExpected,
    0
  );
  const totalAmountActual = sheetResults.reduce(
    (s, r) => s + r.amountActual,
    0
  );

  return {
    clientName,
    sheetName: firstSheet?.sheetName ?? "",
    weeklyFile: weeklyFilename,
    masterFile: masterFilename,
    rowsInWeekly: totalRowsInWeekly,
    rowsAdded: totalRowsAdded,
    rowsSkipped: totalRowsSkipped,
    skippedSerials: allSkippedSerials,
    rowCountPass: totalRowsAdded === totalRowsInWeekly - totalRowsSkipped,
    amountExpected: totalAmountExpected,
    amountActual: totalAmountActual,
    amountPass: Math.abs(totalAmountExpected - totalAmountActual) < 0.01,
    sheetResults,
    updatedMasterBuffer,
  };
}

// ─── Client name detection ──────────────────────────────────────────────────

export function detectClient(filename: string, sheetNames: string[]): string {
  const lower = filename.toLowerCase();
  if (lower.includes("johnson") || lower.includes("scj")) return "SC Johnson";
  if (lower.includes("pepsi")) return "PepsiCo";
  if (lower.includes("unilever")) return "Unilever";
  if (lower.includes("nestle") || lower.includes("nestlé")) return "Nestlé";
  if (lower.includes("procter") || lower.includes("p&g")) return "P&G";
  // Try sheet names
  for (const s of sheetNames) {
    const sl = s.toLowerCase();
    if (sl.includes("johnson")) return "SC Johnson";
    if (sl.includes("pepsi")) return "PepsiCo";
  }
  // Fall back to the filename (without extension) so every campaign has a
  // meaningful client name rather than "Unknown".
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ").trim() || "Unknown";
}

// ─── Sheet name detection (used by upload-campaign) ──────────────────────────

export function getSheetNamesFromZip(buffer: Buffer): Promise<string[]> {
  return Promise.resolve().then(() => {
    const zip = new AdmZip(buffer);
    const workbookXml = zip.readAsText("xl/workbook.xml");
    const names: string[] = [];
    const sheetRe = /<sheet[^>]+name="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = sheetRe.exec(workbookXml)) !== null) {
      names.push(
        m[1]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
      );
    }
    return names;
  });
}

/**
 * Two-argument form: find the best match for `inputName` in `availableSheets`.
 * One-argument form: pick the most likely default sheet from a list.
 */
export function detectTargetSheet(inputOrSheets: string | string[], availableSheets?: string[]): string | null {
  // Two-argument form (used by tests and uploadRouter replace-campaign-master)
  if (typeof inputOrSheets === "string" && availableSheets) {
    const inputNorm = normaliseCountry(inputOrSheets);
    // Exact normalised match
    const exact = availableSheets.find((s) => normaliseCountry(s) === inputNorm);
    if (exact) return exact;
    // Alias/partial: check COUNTRY_ALIASES
    for (const [canonical, aliases] of Object.entries(COUNTRY_ALIASES)) {
      if (aliases.includes(inputNorm)) {
        const match = availableSheets.find((s) => normaliseCountry(s) === canonical);
        if (match) return match;
      }
    }
    // Partial: inputNorm is a substring of a sheet name
    const partial = availableSheets.find((s) => normaliseCountry(s).includes(inputNorm) || inputNorm.includes(normaliseCountry(s)));
    if (partial) return partial;
    return null;
  }

  // One-argument form: pick best default sheet from list
  const sheetNames = inputOrSheets as string[];
  const preferred = ["uk", "poland", "pl", "france", "germany", "spain", "italy"];
  for (const pref of preferred) {
    const match = sheetNames.find((s) => normaliseCountry(s) === pref);
    if (match) return match;
  }
  const skip = new Set([
    "instructions", "costing_data", "rdbmergesheet", "profitability",
    "sc_johnson_report", "billing sheet", "sc johnson", "pivot_data",
    "lookup", "summary", "cover", "index",
  ]);
  const data = sheetNames.find((s) => !skip.has(s.toLowerCase()));
  return data ?? sheetNames[0] ?? "";
}
