import type { DocumentFileType } from "./documentConfig";
import { parseText } from "./parsers/textParser";
import { parseJson } from "./parsers/jsonParser";
import { parseCsv } from "./parsers/csvParser";
import { parsePdf } from "./parsers/pdfParser";
import { parseDocx } from "./parsers/docxParser";
import { DocumentParser, DocumentParseError } from "./parsers/parserTypes";

// Documents v1A — the one routing abstraction between "a DocumentFileType
// and a file's bytes" and "extracted text" (Objective 12). Every parser
// has the identical `(buffer) => Promise<string>` shape, so this is a
// plain lookup + call, not a conditional chain. txt/md/code all share
// parseText — Objective 6 is explicit that Markdown is stored as source
// text, not rendered, so there's no meaningful difference in extraction
// behavior between those three categories at this stage.
const PARSERS: Record<DocumentFileType, DocumentParser> = {
  txt: parseText,
  md: parseText,
  code: parseText,
  json: parseJson,
  csv: parseCsv,
  pdf: parsePdf,
  docx: parseDocx,
};

export { DocumentParseError };

export async function extractDocumentText(fileType: DocumentFileType, buffer: Buffer): Promise<string> {
  const parser = PARSERS[fileType];
  return parser(buffer);
}
