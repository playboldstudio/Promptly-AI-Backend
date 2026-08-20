/**
 * Minimal RFC-4180-ish CSV parser.
 *
 * Handles quoted fields, escaped quotes ("foo""bar"), commas and newlines
 * inside quotes, CRLF/LF line endings and a leading UTF-8 BOM. Blank lines and
 * fully-empty rows are skipped. No external dependency — Cloud Run images stay
 * small.
 */

/** Parse CSV text into an array of string records (rows). */
export function parseCsv(text) {
  const normalized = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');

  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];

    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n') {
      record.push(field);
      field = '';
      if (record.some((c) => c.trim() !== '')) records.push(record);
      record = [];
    } else {
      field += ch;
    }
  }

  if (field !== '' || record.length) {
    record.push(field);
    if (record.some((c) => c.trim() !== '')) records.push(record);
  }

  return records;
}

/**
 * Parse CSV text into objects keyed by the (lower-cased) header row.
 * Returns { header: string[] | null, rows: Record<string, string>[] }.
 */
export function csvToObjects(text) {
  const records = parseCsv(text);
  if (!records.length) return { header: null, rows: [] };

  const header = records[0].map((h) => h.trim().toLowerCase());
  const rows = records.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = (r[i] ?? '').trim();
    });
    return obj;
  });

  return { header, rows };
}