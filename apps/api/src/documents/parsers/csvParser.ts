import { DocumentParseError } from "./parserTypes";

// Documents v1A — a small, self-contained CSV parser (Objective 8): no
// new dependency for what's explicitly scoped as "a normalized textual/
// CSV representation," not real spreadsheet analytics. Handles the part
// of the CSV spec that actually trips up a naive `split(",")`: quoted
// fields containing commas, embedded newlines, and escaped `""` quotes.
//
// Output is a readable pipe-delimited table (row/column structure stays
// visually obvious) with a separator line under the header row, e.g.:
//
//   name | role
//   -----+-----
//   Devin | Engineer

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // consume the escaped quote's second character
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      // Treat \r\n as one break: skip a lone \n immediately following \r.
      if (char === "\r" && text[i + 1] === "\n") continue;

      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  // Flush a trailing field/row that had no final newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export async function parseCsv(buffer: Buffer): Promise<string> {
  const raw = buffer.toString("utf-8");

  if (raw.trim().length === 0) {
    throw new DocumentParseError("The file appears to be empty — no CSV content found.");
  }

  const rows = parseCsvRows(raw);

  if (rows.length === 0) {
    throw new DocumentParseError("No rows could be read from this CSV file.");
  }

  const columnCount = Math.max(...rows.map((r) => r.length));
  const lines: string[] = [];

  rows.forEach((row, index) => {
    const padded = Array.from({ length: columnCount }, (_, i) => (row[i] ?? "").trim());
    lines.push(padded.join(" | "));

    if (index === 0 && rows.length > 1) {
      lines.push(padded.map(() => "---").join("-+-"));
    }
  });

  return lines.join("\n");
}
