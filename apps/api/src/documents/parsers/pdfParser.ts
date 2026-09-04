import { PDFParse } from "pdf-parse";
import { DocumentParseError } from "./parserTypes";

// Documents v1A — machine-readable PDF text extraction via pdf-parse 2.x's
// PDFParse class (Objective 5). Deliberately NOT OCR: a scanned/image-only
// PDF has no text layer for pdf-parse to find, and that case is reported
// honestly (Objective 5's own example wording) rather than silently
// producing an empty "successful" document.
export async function parsePdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });

  let text: string;

  try {
    // pageJoiner defaults to inserting a "\n-- N of total --" marker after
    // every page, which is non-empty even for a page with zero real text —
    // that made the empty-text check below never actually fire. Disabling
    // it also just produces cleaner stored text generally (no boilerplate
    // page-boundary junk mixed into a document's content).
    const result = await parser.getText({ pageJoiner: "" });
    text = result.text ?? "";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DocumentParseError(`Could not read this PDF: ${detail}`);
  } finally {
    await parser.destroy();
  }

  if (text.trim().length === 0) {
    throw new DocumentParseError("No extractable text found. This may be an image/scanned PDF.");
  }

  return text;
}
