import { DocumentParseError } from "./parserTypes";

// Documents v1A — validates the file actually parses as JSON, then stores
// a pretty-printed textual representation (Objective 7). Pretty-printing
// normalizes whitespace for readability without "flattening" anything —
// the same keys, values, and nesting the file already had, just formatted
// consistently regardless of how compact/inconsistent the original
// formatting was. Malformed JSON is reported honestly rather than stored
// as a broken/empty document.
export async function parseJson(buffer: Buffer): Promise<string> {
  const raw = buffer.toString("utf-8");

  if (raw.trim().length === 0) {
    throw new DocumentParseError("The file appears to be empty — no JSON content found.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DocumentParseError(`This file is not valid JSON: ${detail}`);
  }

  return JSON.stringify(parsed, null, 2);
}
