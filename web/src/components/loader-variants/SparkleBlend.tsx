import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Group } from "three";
import { ShaderCanvas, SparkleShape } from "./shared";

// Static front-facing sparkle with the retro low-framerate stepped pulse
// (same cadence as sparkle-field-etch, centered on a single sparkle).
function RetroPulseSparkle() {
  const ref = useRef<Group>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    const fps = 3;
    const steps = [
      0.7, 0.78, 0.9, 1.0, 0.95, 0.88, 0.82, 0.77, 0.73, 0.7, 0.7, 0.7,
    ];
    const i = Math.floor(t * fps);
    const pulse = steps[((i % steps.length) + steps.length) % steps.length];
    ref.current.scale.setScalar(pulse);
  });
  return (
    <group ref={ref}>
      <SparkleShape />
    </group>
  );
}

export default function SparkleBlend() {
  return (
    <ShaderCanvas effect="blend">
      <RetroPulseSparkle />
    </ShaderCanvas>
  );
}
