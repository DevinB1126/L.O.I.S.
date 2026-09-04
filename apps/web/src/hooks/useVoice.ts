import { useEffect, useRef, useState } from "react";
import type { Agent, VoiceState } from "../types";
import type { ChatController } from "./useChat";

// Groups voice state together with the actions that drive it, so
// consumers take one cohesive object instead of a pile of unrelated props.
export interface VoiceController {
  voiceState: VoiceState;
  setVoiceState: (state: VoiceState) => void;
  speak: (text: string) => void;
  stopSpeaking: () => void;
  startListening: (onTranscript: (transcript: string) => void) => void;
}

// Projects v1A — the mic-button handler App.tsx already builds for the
// global chat, generalized into a reusable factory so a project chat's own
// Composer (see components/projects/ProjectChatView.tsx) can get an
// equivalent handler bound to ITS OWN ChatController, without duplicating
// the voice-state logic or spinning up a second, competing voice
// controller — every mic press anywhere in the app still drives the one
// shared VoiceController passed in.
export function createMicClickHandler(voice: VoiceController, chat: ChatController): () => void {
  return () => {
    if (voice.voiceState === "speaking") {
      voice.stopSpeaking();
      return;
    }

    voice.startListening((transcript) => {
      chat.setMessage(transcript);
      chat.sendMessage(transcript);
    });
  };
}

// Owns browser speech recognition (SpeechRecognition / webkitSpeechRecognition,
// typed via ../types/web-speech.d.ts) and speech synthesis (speechSynthesis),
// plus the standby/listening/thinking/speaking voiceState machine. Preserves
// the original App.tsx behavior, including LOIS/IGNIS voice preferences and
// name-normalization on transcripts.
//
// `agent` is read fresh on every render (same as the original component-scoped
// closures), so speak() and startListening() always use the current agent.
export function useVoice(agent: Agent): VoiceController {
  const [voiceState, setVoiceState] = useState<VoiceState>("standby");

  // Tracks the in-flight recognition session (if any), so a second mic click
  // while already listening can't spin up an overlapping instance, and so
  // there is a concrete handle to tear down on unmount.
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  useEffect(() => {
    window.speechSynthesis.getVoices();

    window.speechSynthesis.onvoiceschanged = () => {
      window.speechSynthesis.getVoices();
    };

    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // If this hook is ever torn down mid-listen (e.g. hot reload), abort the
  // active recognition session instead of leaving it running against a
  // component that no longer exists.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  function stopSpeaking() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    setVoiceState("standby");
  }

  function speak(text: string) {
    if (!("speechSynthesis" in window)) {
      setVoiceState("standby");
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);

    const voices = window.speechSynthesis.getVoices();

    let selectedVoice: SpeechSynthesisVoice | undefined;

    if (agent === "lois") {
      selectedVoice =
        voices.find((v) => v.name === "Google UK English Female") ||
        voices.find((v) => v.name === "Martha") ||
        voices.find((v) => v.name === "Flo (English (United Kingdom))") ||
        voices.find((v) => v.name === "Samantha");
    } else {
      selectedVoice =
        voices.find((v) => v.name === "Daniel (English (United Kingdom))") ||
        voices.find((v) => v.name === "Google UK English Male") ||
        voices.find((v) => v.name === "Arthur") ||
        voices.find((v) => v.name === "Aaron");
    }

    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }

    utterance.lang = agent === "lois" ? "en-GB" : "en-GB";
    utterance.rate = agent === "lois" ? 1.1 : 1.0;
    utterance.pitch = agent === "lois" ? 1.22 : 0.82;
    setVoiceState("speaking");

    utterance.onend = () => {
      setVoiceState("standby");
    };

    utterance.onerror = () => {
      setVoiceState("standby");
    };

    window.speechSynthesis.speak(utterance);
  }

  function startListening(onTranscript: (transcript: string) => void) {
    const SpeechRecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      alert("Speech Recognition is not supported in this browser.");
      return;
    }

    // Guard against a second overlapping session (e.g. a fast double-click
    // of the mic button) — the UI only ever has one mic button, so only one
    // active recognition session should exist at a time.
    if (recognitionRef.current) {
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognitionRef.current = recognition;

    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    setVoiceState("listening");

    recognition.start();

    recognition.onresult = (event) => {
      const rawTranscript = event.results[0]?.[0]?.transcript ?? "";
      const transcript = normalizeAgentNames(rawTranscript);

      onTranscript(transcript);
    };

    recognition.onerror = () => {
      recognitionRef.current = null;
      setVoiceState("standby");
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setVoiceState("standby");
    };
  }

  return { voiceState, setVoiceState, speak, stopSpeaking, startListening };
}

// Recognition frequently mishears "LOIS"/"IGNIS" as similar-sounding words;
// this normalizes the common variants so the agent names read correctly in
// the submitted transcript.
function normalizeAgentNames(transcript: string): string {
  return transcript
    .replace(/\blouis\b/gi, "LOIS")
    .replace(/\blewis\b/gi, "LOIS")
    .replace(/\blois\b/gi, "LOIS")
    .replace(/\bignis\b/gi, "IGNIS");
}
