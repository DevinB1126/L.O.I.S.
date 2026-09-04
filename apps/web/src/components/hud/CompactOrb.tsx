import type { VoiceState } from "../../types";

interface CompactOrbProps {
  voiceState: VoiceState;
  currentAgentLabel: string;
}

// Chat workspace pass (Objective B10) — the full cinematic OrbCore (rings,
// orbits, particles, floating status chips, ~310px tall) is demoted to a
// small header-level presence for the chat/project workspace specifically,
// where the transcript is now the dominant element and readability comes
// first. Still the same glowing core visual language (radial gradient,
// agent-color glow, breathing animation) — just sized and positioned so it
// never competes with message text. OrbCore itself is untouched and still
// used at full size for every non-chat view (Objective B10: "stronger
// visibility in non-chat views").
export function CompactOrb({ voiceState, currentAgentLabel }: CompactOrbProps) {
  return (
    <div className="compact-orb-wrap" title={`${currentAgentLabel} core — ${voiceState}`}>
      <div className={`compact-orb ${voiceState}`} />
    </div>
  );
}
