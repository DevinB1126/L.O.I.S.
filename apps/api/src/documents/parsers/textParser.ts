import { DocumentParseError } from "./parserTypes";

// Documents v1A — plain text, Markdown, and source-code files (Objective
// 6/24) all share this: read as UTF-8, store the source text verbatim.
// Markdown is deliberately NOT converted to HTML here — Objective 6 is
// explicit that the stored representation is the source text, not a
// rendering of it. Line breaks are preserved exactly as decoded (no
// normalization) since nothing downstream needs a specific line-ending
// convention yet.
export async function parseText(buffer: Buffer): Promise<string> {
  // toString("utf-8") never throws on invalid byte sequences (it replaces
  // them with U+FFFD) — a genuinely binary file masquerading as .txt
  // won't crash the parser, but it also won't look like readable text
  // once decoded, which is an honest (if unglamorous) outcome for that
  // edge case rather than a hidden failure mode.
  const text = buffer.toString("utf-8");

  if (text.trim().length === 0) {
    throw new DocumentParseError("The file appears to be empty — no text content found.");
  }

  return text;
}
