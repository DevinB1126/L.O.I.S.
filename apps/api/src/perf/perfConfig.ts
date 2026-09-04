// Performance Pass v1 (Objective 24) — every tunable performance-related
// value lives here, nowhere else, mirroring the same convention
// RETRIEVAL_CONFIG (memoryRetriever.ts) already established for Memory v2C.
// Values below are set from ACTUAL measurements taken during this pass
// (see the final report), not guesses — each constant's own comment says
// what it's based on.

export const PERF_CONFIG = {
  // ============================================================
  // Ollama model warmth (Objective 12/13)
  // ============================================================

  /** Sent as the `keep_alive` field on every /api/generate and /api/embed
   *  request. Ollama's own default is 5 minutes, after which an idle
   *  model is unloaded and must be reloaded (multi-second cost) on the
   *  next request — a real, measured cold-start source for anyone who
   *  pauses mid-conversation. 30 minutes keeps both the chat model and
   *  the embedding model warm across a realistic working session without
   *  pinning them in memory indefinitely if LOIS is left idle overnight. */
  MODEL_KEEP_ALIVE: "30m",

  // ============================================================
  // Generation parameters (Objective 14/15)
  // ============================================================

  /** Caps how many tokens a single reply can generate. Ollama's own
   *  default for llama3.1 has no practical cap, which is what let replies
   *  run far longer than a request warranted (Objective 15). 700 tokens
   *  is roughly 500-550 words — generous for a genuinely detailed
   *  explanation, but no longer unbounded. This is a ceiling, not a
   *  target: the shared task instructions (agentPrompt.ts) are what teach
   *  proportional length; this just stops runaway generation past what
   *  any reasonable answer needs. */
  MAX_RESPONSE_TOKENS: 700,

  /** Ollama's own default context window for llama3.1 (2048-8192
   *  depending on install) may be smaller OR larger than this app's
   *  actual measured prompt sizes need. Sized from real measurements
   *  taken during this pass (see the final report's prompt-size numbers)
   *  with headroom for the response itself, not left at whatever the
   *  model's Modelfile happens to default to. */
  CONTEXT_WINDOW_TOKENS: 4096,

  // ============================================================
  // Frontend stream rendering (Objective 17/18)
  // ============================================================

  /** Reserved, NOT currently wired into the frontend (Objective 18
   *  explicitly requires measuring before implementing this). Investigation
   *  this pass found the real per-token cost was ChatTranscript re-parsing
   *  EVERY prior message's Markdown on each streamed chunk — fixed instead
   *  by memoizing MessageContent (apps/web/src/components/chat/
   *  MessageContent.tsx), which removes that cost directly without adding
   *  batching complexity or artificial latency. If a future profiling pass
   *  finds a real remaining per-token cost, this is the interval (ms)
   *  a batched-commit implementation should use — under one frame at
   *  typical refresh rates, without reading as choppy/delayed. */
  STREAM_UI_FLUSH_MS: 32,
} as const;
