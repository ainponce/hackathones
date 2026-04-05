import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Group } from "three";
import {
  ShaderCanvas,
  SparkleShape,
  makeStarGrid,
  type StarDef,
} from "./shared";

// Retro-cadence twinkle: stepped scale at low FPS, asymmetric bloom + slow decay
// + quiet hold. Evokes low-framerate 2D games and old illustrated-book sparkles.
function TwinklingSparkle({ position, baseScale, speed, phase }: StarDef) {
  const ref = useRef<Group>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    const fps = 2.5 + (speed % 2.5);
    const steps = [
      0.3, 0.55, 0.85, 1.0, 0.85, 0.65, 0.5, 0.4, 0.32, 0.3, 0.3, 0.3,
    ];
    const i = Math.floor(t * fps + phase * steps.length);
    const pulse = steps[((i % steps.length) + steps.length) % steps.length];
    ref.current.scale.setScalar(baseScale * pulse);
  });
  return (
    <group ref={ref} position={position}>
      <SparkleShape />
    </group>
  );
}

function StarField() {
  const stars = useMemo<StarDef[]>(() => makeStarGrid(), []);
  return (
    <>
      {stars.map((s, i) => (
        <TwinklingSparkle key={i} {...s} />
      ))}
    </>
  );
}

export default function SparkleFieldEtch() {
  return (
    <ShaderCanvas effect="etch">
      <StarField />
    </ShaderCanvas>
  );
}
