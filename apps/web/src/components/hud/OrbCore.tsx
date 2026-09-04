import type { VoiceState } from "../../types";

interface OrbCoreProps {
  voiceState: VoiceState;
  currentAgentLabel: string;
}

// The animated AI orb/core visual region (.orb-zone), including its orbits,
// rings, satellites, particles, and status chips. Moved out of App.tsx
// verbatim — same class names and nesting, since App.css targets this
// structure directly (including state-driven selectors like
// `.state-listening .orb-core`, which key off the ancestor `.hud` element).
export function OrbCore({ voiceState, currentAgentLabel }: OrbCoreProps) {
  return (
    <section className="orb-zone">
      <div className="star-field" />

      <div className="orbit orbit-1" />
      <div className="orbit orbit-2" />
      <div className="orbit orbit-3" />
      <div className="orbit orbit-4" />

      <div className="orb-status-chip left-chip">
        <strong>CORE LINK</strong>
        <span>Latency: 22 ms</span>
      </div>

      <div className="orb-status-chip right-chip">
        <strong>VOICE</strong>
        <span>{voiceState.toUpperCase()}</span>
      </div>

      <div className="satellite satellite-1" />
      <div className="satellite satellite-2" />
      <div className="satellite satellite-3" />

      <div className="crosshair horizontal" />
      <div className="crosshair vertical" />

      <div className="orb-ring ring-1" />
      <div className="orb-ring ring-2" />
      <div className="orb-ring ring-3" />

      <div className="core-halo halo-1" />
      <div className="core-halo halo-2" />
      <div className="core-halo halo-3" />

      <div className="core-segment-ring">
        {Array.from({ length: 32 }).map((_, index) => (
          <span key={index} />
        ))}
      </div>

      <div className="core-pulse pulse-1" />
      <div className="core-pulse pulse-2" />
      <div className="core-pulse pulse-3" />

      <div className="orb-particles">
        {Array.from({ length: 10 }).map((_, index) => (
          <span key={index} className={`orb-particle particle-${index + 1}`} />
        ))}
      </div>

      <div className={`orb-core ${voiceState}`}>
        <span>{currentAgentLabel}</span>
      </div>
    </section>
  );
}
