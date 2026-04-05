import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Group } from "three";
import { ShaderCanvas, SparkleShape } from "./shared";

function RotatingSparkle() {
  const ref = useRef<Group>(null);
  useFrame((_, delta) => {
    if (!ref.current) return;
    ref.current.rotation.x += delta * 0.2;
    ref.current.rotation.y += delta * 0.3;
  });
  return (
    <group ref={ref}>
      <SparkleShape />
    </group>
  );
}

export default function SparkleShader() {
  return (
    <ShaderCanvas effect="ascii">
      <RotatingSparkle />
    </ShaderCanvas>
  );
}
