import type { VoiceState } from "../../types";

interface VoiceActivityIndicatorProps {
  voiceState: VoiceState;
  voiceLabel: string;
}

// Chat workspace pass (Objective B7/B8) — replaces the old ALWAYS-visible
// waveform + "VOICE MODULE STANDBY" strip, which permanently reserved a
// chunk of the center panel for one of four possible states, three of them
// rare. Voice status now lives primarily in the composer's own mic button
// (color/state already reflects voiceState) and the existing System
// Status "Voice: ..." line (RightPanels) — this component renders NOTHING
// at all during standby, so that space is fully reclaimed for the
// transcript/composer, and only appears (as a slim temporary strip, not a
// tall permanent one) while something is actually happening.
export function VoiceActivityIndicator({ voiceState, voiceLabel }: VoiceActivityIndicatorProps) {
  if (voiceState === "standby") return null;

  return (
    <section className={`voice-activity voice-activity--${voiceState}`}>
      {voiceState === "thinking" ? (
        <div className="voice-thinking-dots">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <div className={`wave ${voiceState}`}>
          {Array.from({ length: 32 }).map((_, index) => (
            <span key={index} />
          ))}
        </div>
      )}

      <p>{voiceLabel}</p>
    </section>
  );
}
