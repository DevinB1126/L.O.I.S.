// Documents v1A — every tunable value and the supported-extension map live
// here, nowhere else (Objective 9: "do not scatter limits through code").

export type DocumentFileType = "txt" | "md" | "json" | "csv" | "pdf" | "docx" | "code";

/** Reasonable default for local development — generous enough for real
 *  notes/resumes/specs, small enough that a single upload can't stall the
 *  synchronous parse step for long. */
export const MAX_DOCUMENT_SIZE_MB = 20;
export const MAX_DOCUMENT_SIZE_BYTES = MAX_DOCUMENT_SIZE_MB * 1024 * 1024;

// Extension (lowercased, including the leading dot) -> the category the
// rest of the system reasons about. This IS the whitelist: an extension
// not listed here is rejected as unsupported before any file is written to
// disk (Objective 4/9). It's also the ONLY source of the physical storage
// extension (Objective 10) — never derived from the raw uploaded filename
// beyond this lookup, so a crafted filename can't smuggle an unexpected
// extension onto disk.
export const SUPPORTED_EXTENSIONS: Readonly<Record<string, DocumentFileType>> = {
  ".txt": "txt",
  ".md": "md",
  ".markdown": "md",
  ".json": "json",
  ".csv": "csv",
  ".pdf": "pdf",
  ".docx": "docx",
  // Objective 24 — optional source-code support, treated as plain UTF-8
  // text (same parser as .txt). Deliberately a short, common list rather
  // than an attempt to cover every language.
  ".ts": "code",
  ".tsx": "code",
  ".js": "code",
  ".jsx": "code",
  ".py": "code",
  ".java": "code",
  ".cs": "code",
  ".go": "code",
  ".rs": "code",
  ".html": "code",
  ".css": "code",
  ".yaml": "code",
  ".yml": "code",
};

export function isSupportedExtension(ext: string): ext is keyof typeof SUPPORTED_EXTENSIONS {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_EXTENSIONS, ext.toLowerCase());
}

export function fileTypeForExtension(ext: string): DocumentFileType | null {
  return SUPPORTED_EXTENSIONS[ext.toLowerCase()] ?? null;
}
