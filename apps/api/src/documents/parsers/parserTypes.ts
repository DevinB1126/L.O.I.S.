// Documents v1A — shared parser contract. Every parser (text/markdown/
// json/csv/pdf/docx) implements the same async signature regardless of
// whether the underlying work is actually synchronous, so
// documentTextExtractor.ts (the router) has exactly one shape to call
// through (Objective 12: no giant conditional spaghetti in the route).

/** Thrown by a parser for a file it recognizes but cannot extract usable
 *  text from — malformed JSON, a corrupt/unreadable PDF, a scanned PDF
 *  with no text layer, a corrupt DOCX. Always carries a message honest
 *  enough to show a user directly (Objective 22), never a raw stack
 *  trace or "500 INTERNAL ERROR". Distinct from "unsupported extension",
 *  which is rejected before a parser ever runs. */
export class DocumentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentParseError";
  }
}

export type DocumentParser = (buffer: Buffer) => Promise<string>;
