// The decorative space/HUD backdrop (starfield, constellation network,
// nebula, holo-map, scanlines, etc). Purely presentational — no state, no
// props — moved out of App.tsx verbatim. DOM structure and class names are
// unchanged since App.css targets these classes directly.
export function BackgroundScene() {
  return (
    <>
      <div className="deep-space" />
      <div className="space-scene">
        <div className="constellation-network">
          {Array.from({ length: 12 }).map((_, index) => (
            <span key={index} className={`const-node node-${index + 1}`} />
          ))}

          <i className="const-line line-1" />
          <i className="const-line line-2" />
          <i className="const-line line-3" />
          <i className="const-line line-4" />
          <i className="const-line line-5" />
          <i className="const-line line-6" />
        </div>
        <div className="nebula-cloud" />
        <div className="galaxy-band" />
        <div className="earth-limb" />
        <div className="nebula-cloud" />
        <div className="star-density-layer" />
        <div className="bright-star star-one" />
        <div className="bright-star star-two" />
        <div className="bright-star star-three" />
        <div className="bright-star star-four" />
        <div className="constellation constellation-left" />
        <div className="constellation constellation-right" />
        <div className="planet-mini" />
        <div className="coordinate-readout">
          <span>34.0522° N</span>
          <span>118.2437° W</span>
          <span>EARTH ORBITAL GRID</span>
        </div>
        <div className="holo-map-v2">
          <span className="map-dot dot-1" />
          <span className="map-dot dot-2" />
          <span className="map-dot dot-3" />
          <span className="map-dot dot-4" />
        </div>

        <div className="sys-readout readout-a">SYS_0047</div>
        <div className="sys-readout readout-b">ORBITAL NET</div>
        <div className="sys-readout readout-c">LOCAL NODE ACTIVE</div>
      </div>
      <div className="background-grid" />
      <div className="data-map" />
      <div className="network-field" />
      <div className="planet-glow" />
      <div className="mountain-grid" />
      <div className="side-orbital" />
      <div className="stars" />
      <div className="data-stream" />
      <div className="world-map" />
      <div className="right-holo-column" />
      <div className="particle-field">
        {Array.from({ length: 36 }).map((_, index) => (
          <span key={index} />
        ))}
      </div>
      <div className="holo-world-layer">
        <div className="world-node node-a" />
        <div className="world-node node-b" />
        <div className="world-node node-c" />
        <div className="world-node node-d" />
      </div>
      <div className="scanlines" />
    </>
  );
}
