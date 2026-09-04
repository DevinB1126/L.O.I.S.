import mammoth from "mammoth";
import { DocumentParseError } from "./parserTypes";

// Documents v1A — optional DOCX support via mammoth (a clean, established
// dependency for exactly this: pulling plain text out of a .docx). Uses
// extractRawText (not the HTML-conversion path) since Objective 6's
// "store the source text, not a rendering of it" applies here too — no
// reason to keep formatting/markup for a plain-text extraction stage.
export async function parseDocx(buffer: Buffer): Promise<string> {
  let text: string;

  try {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value ?? "";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DocumentParseError(`Could not read this DOCX file: ${detail}`);
  }

  if (text.trim().length === 0) {
    throw new DocumentParseError("No extractable text found in this DOCX file.");
  }

  return text;
}
