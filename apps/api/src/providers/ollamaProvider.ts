import axios from "axios";
import { NdjsonBuffer, OllamaStreamRecord } from "./ndjsonParser";
import { PERF_CONFIG } from "../perf/perfConfig";

const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_GENERATE_URL = `${OLLAMA_BASE_URL}/api/generate`;
const OLLAMA_MODEL = "llama3.1";

// Performance Pass v1 (Objectives 12, 14) — sent on every generate request:
// - keep_alive: without this, Ollama unloads the model after its own
//   default 5-minute idle timeout, forcing a full reload (measured at
//   ~40s+ on this CPU-only machine) on the next request. This alone
//   explains most of the cold-vs-warm TTFT gap measured in this pass.
// - num_ctx / num_predict: Ollama/the model's Modelfile defaults were
//   previously unconstrained. These centralize sane bounds (see
//   perfConfig.ts for the reasoning behind each value) rather than leaving
//   every request to whatever the model happened to default to.
const GENERATE_OPTIONS = {
  keep_alive: PERF_CONFIG.MODEL_KEEP_ALIVE,
  options: {
    num_ctx: PERF_CONFIG.CONTEXT_WINDOW_TOKENS,
    num_predict: PERF_CONFIG.MAX_RESPONSE_TOKENS,
  },
};

export interface StreamOptions {
  /** Propagated to the underlying fetch so callers can cancel generation. */
  signal?: AbortSignal;
}

/** Thrown for connection/HTTP-level failures talking to Ollama. */
export class OllamaRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "OllamaRequestError";
    this.status = status;
  }
}

/** Thrown when Ollama itself reports an error mid-stream. */
export class OllamaStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaStreamError";
  }
}

type OllamaGenerateResponse = {
  response: string;
};

// Ollama Scheduler v1 (Objective 13) — `signal` is optional and forwarded
// straight to axios's own native AbortSignal support, so a caller going
// through the scheduler (or the client-disconnect path) can actually
// interrupt this request at the network level, not just stop waiting on it.
export async function askOllama(prompt: string, signal?: AbortSignal): Promise<string> {
  const response = await axios.post<OllamaGenerateResponse>(
    OLLAMA_GENERATE_URL,
    {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      ...GENERATE_OPTIONS,
    },
    { signal }
  );

  return response.data.response;
}

/**
 * Streams a completion from Ollama, calling `onChunk` with each piece of
 * response text as it arrives, and resolving with the full concatenated
 * reply once the stream ends.
 *
 * Hardening applied here:
 * - NDJSON records are reconstructed from a buffer (see ndjsonParser.ts)
 *   instead of JSON.parse()-ing raw chunks, since chunk boundaries do not
 *   align with line boundaries.
 * - decoder.decode(value, { stream: true }) is used while reading so a
 *   multi-byte UTF-8 character split across two chunks decodes correctly;
 *   the decoder is flushed once the stream ends.
 * - Non-2xx responses and missing bodies raise OllamaRequestError.
 * - An `error` field in any NDJSON record raises OllamaStreamError instead
 *   of being silently appended to the reply.
 * - `options.signal` is forwarded to fetch so a caller (the Express route)
 *   can abort generation if the client disconnects.
 */
export async function streamOllamaResponse(
  prompt: string,
  onChunk: (chunk: string) => void,
  options: StreamOptions = {}
): Promise<string> {
  let response: Response;

  try {
    response = await fetch(OLLAMA_GENERATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: true,
        ...GENERATE_OPTIONS,
      }),
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;

    const reason = error instanceof Error ? error.message : String(error);
    throw new OllamaRequestError(`Failed to reach Ollama at ${OLLAMA_GENERATE_URL}: ${reason}`);
  }

  if (!response.ok) {
    const bodyText = await safeReadText(response);
    throw new OllamaRequestError(
      `Ollama responded with status ${response.status}: ${bodyText || response.statusText}`,
      response.status
    );
  }

  if (!response.body) {
    throw new OllamaRequestError("No response body from Ollama");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const ndjson = new NdjsonBuffer();

  let fullReply = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      const decoded = decoder.decode(value, { stream: true });
      fullReply = applyRecords(ndjson.push(decoded), onChunk, fullReply);
    }

    // Flush any bytes the decoder was holding back (an in-progress
    // multi-byte character at the very end of the stream), then flush any
    // trailing NDJSON line that never received its newline terminator.
    const tail = decoder.decode();
    if (tail) {
      fullReply = applyRecords(ndjson.push(tail), onChunk, fullReply);
    }

    fullReply = applyRecords(ndjson.flush(), onChunk, fullReply);
  } finally {
    reader.releaseLock();
  }

  return fullReply;
}

function applyRecords(
  records: OllamaStreamRecord[],
  onChunk: (chunk: string) => void,
  fullReplySoFar: string
): string {
  let fullReply = fullReplySoFar;

  for (const record of records) {
    if (record.error) {
      throw new OllamaStreamError(record.error);
    }

    if (typeof record.response === "string" && record.response.length > 0) {
      fullReply += record.response;
      onChunk(record.response);
    }
  }

  return fullReply;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
