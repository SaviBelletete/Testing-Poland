// ─── Fast ZIP-based sheet name extraction (no full workbook parse) ───────────
// Reads only xl/workbook.xml from the ZIP, which is tiny compared to the full
// file. This avoids ExcelJS loading all cell data and timing out on large
// .xlsm files. Shared by every upload route (upload-campaign,
// replace-campaign-master, process-payments, finalize-upload) so sheet
// detection can't drift between them.

import zlib from "zlib";

export function getSheetNamesFromZip(buffer: Buffer): string[] {
  try {
    let offset = 0;
    const results: string[] = [];

    while (offset < buffer.length - 4) {
      const sig = buffer.readUInt32LE(offset);
      if (sig === 0x04034b50) {
        // Local file header
        const compression = buffer.readUInt16LE(offset + 8);
        const compressedSize = buffer.readUInt32LE(offset + 18);
        const filenameLen = buffer.readUInt16LE(offset + 26);
        const extraLen = buffer.readUInt16LE(offset + 28);
        const filename = buffer.slice(offset + 30, offset + 30 + filenameLen).toString("utf8");
        const dataOffset = offset + 30 + filenameLen + extraLen;

        if (filename === "xl/workbook.xml" || filename === "xl/workbook.xml.rels") {
          const compressedData = buffer.slice(dataOffset, dataOffset + compressedSize);
          let xmlData: Buffer;
          if (compression === 0) {
            xmlData = compressedData;
          } else if (compression === 8) {
            xmlData = zlib.inflateRawSync(compressedData);
          } else {
            xmlData = compressedData;
          }

          if (filename === "xl/workbook.xml") {
            const xml = xmlData.toString("utf8");
            const regex = /<sheet\s[^>]*name="([^"]+)"/g;
            let m: RegExpExecArray | null;
            while ((m = regex.exec(xml)) !== null) {
              results.push(m[1]);
            }
            if (results.length > 0) return results;
          }
        }

        offset = dataOffset + compressedSize;
      } else if (sig === 0x02014b50 || sig === 0x06054b50) {
        break; // central directory
      } else {
        offset++;
      }
    }

    return results;
  } catch {
    return [];
  }
}

export function getSheetNames(buffer: Buffer): string[] {
  return getSheetNamesFromZip(buffer);
}

/**
 * Pick the most likely "default" sheet from a freshly-uploaded master file:
 * prefer a sheet whose name mentions a known country/region, otherwise the
 * first sheet that doesn't look like an RDB/merge helper sheet, otherwise
 * just the first sheet.
 */
export function pickDefaultSheetName(sheetNames: string[]): string {
  const keywords = ["poland", "france", "uk", "germany", "spain", "italy", "arkusz"];
  for (const s of sheetNames) {
    if (keywords.some((k) => s.toLowerCase().includes(k))) return s;
  }
  for (const s of sheetNames) {
    if (!s.toLowerCase().includes("rdb") && !s.toLowerCase().includes("merge")) return s;
  }
  return sheetNames[0] || "";
}
