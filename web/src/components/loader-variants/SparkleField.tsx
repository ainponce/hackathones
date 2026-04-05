import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Group } from "three";
import {
  ShaderCanvas,
  SparkleShape,
  makeStarGrid,
  type StarDef,
} from "./shared";

// Smooth sine twinkle — never fully disappears, suited to the ASCII cell output.
function TwinklingSparkle({ position, baseScale, speed, phase }: StarDef) {
  const ref = useRef<Group>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    const pulse = 0.4 + (Math.sin(t * speed + phase) * 0.5 + 0.5) * 0.6;
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

export default function SparkleField() {
  return (
    <ShaderCanvas effect="ascii">
      <StarField />
    </ShaderCanvas>
  );
}
