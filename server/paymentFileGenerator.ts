/**
 * Payment File Generator
 *
 * A future-proof, registry-driven system for generating payment instruction
 * files (Wise XLSX, Wise CSV, PayPal CSV) from newly-added master rows.
 *
 * To add a new payment provider or format:
 *   1. Define a new PaymentFormat entry in PAYMENT_FORMATS below.
 *   2. If the output type is new, add a case to buildFileBuffer().
 *   That's it — no core logic changes needed.
 */

import ExcelJS from "exceljs";

// ─── Row shape (subset of WeeklyRow used for payment generation) ───────────

export interface PaymentRow {
  firstName: string;
  lastName: string;
  email: string;
  paypalAccount: string;
  accountNumber: string;
  sortCode: string;
  iban?: string;
  bic?: string;
  value: number;
  currency: string;
  payType: string;
  paymentReference: string; // e.g. campaign/client name
}

// ─── Format registry ────────────────────────────────────────────────────────

export type OutputFormat = "wise-xlsx" | "wise-csv" | "paypal-csv";

export interface PaymentFormat {
  /** Human-readable label shown in the UI */
  label: string;
  /** File name template — {currency} and {date} are replaced at generation time */
  filenameTemplate: string;
  /** MIME type for the download response */
  mimeType: string;
  /** Output format type */
  outputFormat: OutputFormat;
  /** Routing: which payType values route to this format (lowercase, exact match) */
  payTypes: string[];
  /** Routing: which currencies route to this format (uppercase, exact match).
   *  Empty array = match all currencies for the given payTypes. */
  currencies: string[];
  /** Routing: which currencies are EXCLUDED from this format.
   *  Takes precedence over currencies=[]. */
  excludeCurrencies?: string[];
}

/**
 * The payment format registry.
 *
 * Rows are matched to formats in order — the FIRST matching format wins.
 * Add new formats at the end (or insert before existing ones to override).
 */
export const PAYMENT_FORMATS: PaymentFormat[] = [
  // ── Wise UK (sort code + account number, GBP only) ──────────────────────
  {
    label: "Wise UK (GBP bank transfer)",
    filenameTemplate: "WiseUK-{date}.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    outputFormat: "wise-xlsx",
    payTypes: ["bacs", "bank"],
    currencies: ["GBP"],
  },

  // ── Wise International CSV (IBAN + BIC, all currencies except GBP) ──────
  {
    label: "Wise EUR (bank transfer)",
    filenameTemplate: "WiseEUR-{date}.csv",
    mimeType: "text/csv",
    outputFormat: "wise-csv",
    payTypes: ["transferwise", "bank"],
    currencies: ["EUR"],
  },
  {
    label: "Wise CHF (bank transfer)",
    filenameTemplate: "WiseCHF-{date}.csv",
    mimeType: "text/csv",
    outputFormat: "wise-csv",
    payTypes: ["transferwise", "bank"],
    currencies: ["CHF"],
  },
  {
    label: "Wise ZAR (bank transfer)",
    filenameTemplate: "WiseZAR-{date}.csv",
    mimeType: "text/csv",
    outputFormat: "wise-csv",
    payTypes: ["transferwise", "rebacs", "bank"],
    currencies: ["ZAR"],
  },
  {
    label: "Wise PLN (bank transfer)",
    filenameTemplate: "WisePLN-{date}.csv",
    mimeType: "text/csv",
    outputFormat: "wise-csv",
    payTypes: ["transferwise", "bank"],
    currencies: ["PLN"],
  },
  {
    label: "Wise TRY (bank transfer)",
    filenameTemplate: "WiseTRY-{date}.csv",
    mimeType: "text/csv",
    outputFormat: "wise-csv",
    payTypes: ["transferwise", "bank"],
    currencies: ["TRY"],
  },
  {
    label: "Wise SEK (bank transfer)",
    filenameTemplate: "WiseSEK-{date}.csv",
    mimeType: "text/csv",
    outputFormat: "wise-csv",
    payTypes: ["transferwise", "bank"],
    currencies: ["SEK"],
  },

  // ── PayPal GBP ───────────────────────────────────────────────────────────
  {
    label: "PayPal GBP",
    filenameTemplate: "PayPalGBP-{date}.csv",
    mimeType: "text/csv",
    outputFormat: "paypal-csv",
    payTypes: ["paypal"],
    currencies: ["GBP"],
  },

  // ── PayPal EUR ───────────────────────────────────────────────────────────
  {
    label: "PayPal EUR",
    filenameTemplate: "PayPalEUR-{date}.csv",
    mimeType: "text/csv",
    outputFormat: "paypal-csv",
    payTypes: ["paypal"],
    currencies: ["EUR"],
  },

  // ── PayPal (all other currencies) ────────────────────────────────────────
  {
    label: "PayPal (other currencies)",
    filenameTemplate: "PayPal{currency}-{date}.csv",
    mimeType: "text/csv",
    outputFormat: "paypal-csv",
    payTypes: ["paypal"],
    currencies: [], // matches any currency not already matched above
    excludeCurrencies: ["GBP", "EUR"],
  },
];

// ─── Routing ────────────────────────────────────────────────────────────────

function matchFormat(row: PaymentRow): PaymentFormat | null {
  const pt = row.payType.toLowerCase().trim();
  const cur = row.currency.toUpperCase().trim();

  for (const fmt of PAYMENT_FORMATS) {
    if (!fmt.payTypes.includes(pt)) continue;
    if (fmt.excludeCurrencies?.includes(cur)) continue;
    if (fmt.currencies.length > 0 && !fmt.currencies.includes(cur)) continue;
    return fmt;
  }
  return null;
}

// ─── File builders ──────────────────────────────────────────────────────────

function buildWiseCsvContent(rows: PaymentRow[], paymentReference: string): string {
  const header =
    "name,recipientEmail,paymentReference,receiverType,amountCurrency,amount,sourceCurrency,targetCurrency, IBAN, BIC";
  const lines = rows.map((r) => {
    const name = `${r.firstName} ${r.lastName}`.trim();
    const iban = (r.iban || r.accountNumber || "").trim();
    const bic = (r.bic || "").trim();
    return [
      name,
      r.email || "",
      paymentReference,
      "Person",
      r.currency,
      r.value,
      r.currency,
      r.currency,
      iban,
      bic,
    ].join(",");
  });
  return [header, ...lines].join("\n");
}

function buildWiseUkXlsxContent(rows: PaymentRow[], paymentReference: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");

  ws.addRow([
    "name",
    "recipientEmail",
    "paymentReference",
    "receiverType",
    "amountCurrency",
    "amount",
    "sourceCurrency",
    "targetCurrency",
    "sortCode",
    "accountNumber",
  ]);

  for (const r of rows) {
    const name = `${r.firstName} ${r.lastName}`.trim();
    // Normalise sort code: remove dashes/spaces → 6 digits
    const sortCode = (r.sortCode || "").replace(/[-\s]/g, "");
    ws.addRow([
      name,
      r.email || null,
      paymentReference,
      "institution",
      "source",
      r.value,
      "GBP",
      "GBP",
      sortCode,
      r.accountNumber,
    ]);
  }

  return wb.xlsx.writeBuffer().then((ab) => Buffer.from(ab)) as Promise<Buffer>;
}

function buildPayPalCsvContent(rows: PaymentRow[], paymentReference: string): string {
  // PayPal mass payment format: email,amount,currency,note
  const lines = rows.map((r) => {
    const email = r.paypalAccount || r.email || "";
    return [email, r.value, r.currency, paymentReference].join(",");
  });
  return lines.join("\n");
}

async function buildFileBuffer(
  fmt: PaymentFormat,
  rows: PaymentRow[],
  paymentReference: string
): Promise<Buffer> {
  switch (fmt.outputFormat) {
    case "wise-csv":
      return Buffer.from(buildWiseCsvContent(rows, paymentReference), "utf-8");
    case "wise-xlsx":
      return await buildWiseUkXlsxContent(rows, paymentReference);
    case "paypal-csv":
      return Buffer.from(buildPayPalCsvContent(rows, paymentReference), "utf-8");
    default:
      throw new Error(`Unknown output format: ${(fmt as PaymentFormat).outputFormat}`);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface GeneratedPaymentFile {
  format: PaymentFormat;
  filename: string;
  buffer: Buffer;
  rowCount: number;
}

/**
 * Generate payment instruction files from a list of newly-added rows.
 *
 * @param rows           The newly-added WeeklyRow-compatible objects
 * @param paymentReference  The campaign/client name used as paymentReference in output files
 * @param dateLabel      Date string used in filenames (e.g. "21-Apr-2026")
 * @returns              One GeneratedPaymentFile per format that has at least one matching row
 */
export async function generatePaymentFiles(
  rows: PaymentRow[],
  paymentReference: string,
  dateLabel: string
): Promise<GeneratedPaymentFile[]> {
  // Group rows by matching format
  const grouped = new Map<PaymentFormat, PaymentRow[]>();

  for (const row of rows) {
    const fmt = matchFormat(row);
    if (!fmt) continue; // unrecognised pay type — skip
    if (!grouped.has(fmt)) grouped.set(fmt, []);
    grouped.get(fmt)!.push(row);
  }

  const results: GeneratedPaymentFile[] = [];

  for (const [fmt, fmtRows] of Array.from(grouped.entries())) {
    if (fmtRows.length === 0) continue;

    const currency = fmtRows[0].currency.toUpperCase();
    const filename = fmt.filenameTemplate
      .replace("{currency}", currency)
      .replace("{date}", dateLabel);

    const buffer = await buildFileBuffer(fmt, fmtRows, paymentReference);

    results.push({
      format: fmt,
      filename,
      buffer,
      rowCount: fmtRows.length,
    });
  }

  return results;
}
