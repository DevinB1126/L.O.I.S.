// Buffered newline-delimited JSON (NDJSON) parser for Ollama's streaming
// responses.
//
// A ReadableStream chunk has no relationship to a line of NDJSON — network
// chunk boundaries can (and do) split a JSON record across two or more
// chunks, and can also deliver several complete records in one chunk. This
// buffer accumulates decoded text and only ever calls JSON.parse() on text
// between two newlines (or, at end-of-stream, on a final unterminated
// line), so callers never JSON.parse() a raw, possibly-incomplete chunk.

export interface OllamaStreamRecord {
  response?: string;
  done?: boolean;
  error?: string;
  [key: string]: unknown;
}

export class NdjsonParseError extends Error {
  readonly rawLine: string;

  constructor(message: string, rawLine: string) {
    super(message);
    this.name = "NdjsonParseError";
    this.rawLine = rawLine;
  }
}

export class NdjsonBuffer {
  private buffer = "";

  /** Feed a decoded text chunk; returns any complete records found so far. */
  push(chunk: string): OllamaStreamRecord[] {
    this.buffer += chunk;
    return this.drainCompleteLines();
  }

  /**
   * Call once the underlying stream has ended. Ollama does not always
   * terminate its final line with a trailing newline, so any non-blank
   * content still sitting in the buffer is parsed as one last record.
   */
  flush(): OllamaStreamRecord[] {
    const remaining = this.buffer;
    this.buffer = "";

    const trimmed = remaining.trim();
    if (!trimmed) return [];

    return [this.parseLine(trimmed)];
  }

  private drainCompleteLines(): OllamaStreamRecord[] {
    const records: OllamaStreamRecord[] = [];
    let newlineIndex: number;

    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      const trimmed = line.trim();
      if (!trimmed) continue; // blank lines between records are ignored

      records.push(this.parseLine(trimmed));
    }

    return records;
  }

  private parseLine(line: string): OllamaStreamRecord {
    try {
      return JSON.parse(line) as OllamaStreamRecord;
    } catch (error) {
      // Malformed data must never be silently dropped — surface it as a
      // typed error so the caller can decide how to fail the request.
      const reason = error instanceof Error ? error.message : String(error);
      throw new NdjsonParseError(`Failed to parse NDJSON line: ${reason}`, line);
    }
  }
}
