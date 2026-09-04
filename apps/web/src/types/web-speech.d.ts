// Minimal ambient types for the browser Web Speech *recognition* API
// (SpeechRecognition / webkitSpeechRecognition).
//
// TypeScript's bundled DOM library does not define these — this file exists
// purely so useVoice.ts can be strongly typed instead of using `any`. It
// declares only what LOIS/IGNIS's voice input actually uses, not the full
// spec (e.g. no SpeechGrammarList, no continuous/interim-results event
// stream handling, since the app always does one-shot final-result
// recognition).
//
// Speech *synthesis* (SpeechSynthesisUtterance, SpeechSynthesisVoice,
// window.speechSynthesis) is already declared by lib.dom.d.ts and needs no
// declarations here.
//
// No imports/exports here on purpose — that keeps this file a global
// ambient script (not a module), so `interface Window` below merges
// directly into the real DOM Window type.

type SpeechRecognitionErrorCode =
  | "no-speech"
  | "aborted"
  | "audio-capture"
  | "network"
  | "not-allowed"
  | "service-not-allowed"
  | "bad-grammar"
  | "language-not-supported";

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: SpeechRecognitionErrorCode;
  readonly message: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;

  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;

  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}
