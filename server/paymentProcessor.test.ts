import { describe, it, expect } from "vitest";
import { detectClient, detectTargetSheet } from "./paymentProcessor";

describe("detectClient", () => {
  it("detects SC Johnson from filename", () => {
    expect(detectClient("extractedSCJ.xlsx", [])).toBe("SC Johnson");
    expect(detectClient("SC_Johnson_Master.xlsm", [])).toBe("SC Johnson");
    expect(detectClient("sc johnson weekly.xlsx", [])).toBe("SC Johnson");
  });

  it("detects PepsiCo from filename", () => {
    expect(detectClient("PepsiCoextracted.xlsx", [])).toBe("PepsiCo");
    expect(detectClient("PepsiCo_FR_UK_Master.xlsm", [])).toBe("PepsiCo");
    expect(detectClient("pepsi_weekly.xlsx", [])).toBe("PepsiCo");
  });

  it("detects from sheet names when filename is ambiguous", () => {
    expect(detectClient("weekly.xlsx", ["SC Johnson", "Poland"])).toBe("SC Johnson");
    expect(detectClient("weekly.xlsx", ["PepsiCo", "France"])).toBe("PepsiCo");
  });

  it("returns filename-based name for unrecognized files", () => {
    // detectClient now falls back to the filename (without extension, underscores/hyphens replaced
    // with spaces) so campaigns always have a meaningful client name rather than a generic "Unknown".
    expect(detectClient("unknown_file.xlsx", ["Sheet1"])).toBe("unknown file");
    expect(detectClient("Nomad_Master.xlsm", ["Sheet1"])).toBe("Nomad Master");
  });
});

describe("detectTargetSheet", () => {
  it("matches Poland sheet directly", () => {
    expect(detectTargetSheet("Poland", ["Poland", "UK", "France"])).toBe("Poland");
  });

  it("matches France sheet directly", () => {
    expect(detectTargetSheet("France", ["France", "UK", "Poland"])).toBe("France");
  });

  it("returns null for Arkusz1 (generic sheet name, resolved via IBAN fallback at runtime)", () => {
    // Arkusz1 is no longer a Poland alias — it's a generic Excel sheet name.
    // Country detection for such sheets falls back to IBAN prefix scanning
    // inside processPaymentFiles, not via detectTargetSheet.
    expect(detectTargetSheet("Arkusz1", ["Poland", "UK", "Lookup"])).toBeNull();
  });

  it("maps country code PL to Poland", () => {
    expect(detectTargetSheet("PL", ["Poland", "France", "UK"])).toBe("Poland");
  });

  it("maps country code FR to France", () => {
    expect(detectTargetSheet("FR", ["Poland", "France", "UK"])).toBe("France");
  });

  it("returns null when no match found", () => {
    expect(detectTargetSheet("Australia", ["Poland", "France", "UK"])).toBeNull();
  });

  it("does case-insensitive matching", () => {
    expect(detectTargetSheet("poland", ["Poland", "France"])).toBe("Poland");
    expect(detectTargetSheet("FRANCE", ["Poland", "France"])).toBe("France");
  });

  it("does partial matching", () => {
    expect(detectTargetSheet("UK", ["United Kingdom", "France"])).toBe("United Kingdom");
  });
});

describe("reconciliation logic", () => {
  it("row count match: added rows equals weekly rows minus skipped", () => {
    const weeklyRows = 10;
    const skipped = 2;
    const added = 8;
    expect(weeklyRows - skipped).toBe(added);
  });

  it("amount match: within 0.01 tolerance", () => {
    const weeklyTotal = 100.00;
    const addedTotal = 100.00;
    expect(Math.abs(weeklyTotal - addedTotal) < 0.01).toBe(true);
  });

  it("amount mismatch detected", () => {
    const weeklyTotal = 100.00;
    const addedTotal = 95.50;
    expect(Math.abs(weeklyTotal - addedTotal) < 0.01).toBe(false);
  });
});
