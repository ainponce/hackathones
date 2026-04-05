import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { AsciiRenderer } from "@react-three/drei";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { WebGPURenderer, RenderPipeline } from "three/webgpu";
import {
  Fn,
  pass,
  uv,
  vec2,
  vec3,
  vec4,
  float,
  texture as tslTexture,
  dot,
  max,
  mod,
  step,
  screenSize,
  time,
  mix,
  fract,
  abs,
  smoothstep,
} from "three/tsl";

const CHARS = " .:-+*=%@#/";
const CELL_SIZE = 8;

export type ShaderEffect = "ascii" | "etch" | "blend";

export type StarDef = {
  position: [number, number, number];
  baseScale: number;
  speed: number;
  phase: number;
};

export function SparkleShape() {
  return (
    <>
      <mesh scale={[0.08, 1.2, 0.08]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      <mesh scale={[1.2, 0.08, 0.08]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      <mesh rotation={[0, 0, Math.PI / 4]} scale={[0.06, 0.7, 0.06]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      <mesh rotation={[0, 0, -Math.PI / 4]} scale={[0.06, 0.7, 0.06]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
    </>
  );
}

// Generate a 4x4 jittered grid of stars that fills the visible frame
// without overlap between neighbors.
export function makeStarGrid(): StarDef[] {
  const out: StarDef[] = [];
  const gridN = 4;
  const spread = 2.9;
  const cell = spread / gridN;
  const maxReach = cell * 0.45;
  const maxScale = maxReach / 1.2;
  for (let i = 0; i < gridN; i++) {
    for (let j = 0; j < gridN; j++) {
      const cx = -spread / 2 + (i + 0.5) * cell;
      const cy = -spread / 2 + (j + 0.5) * cell;
      out.push({
        position: [
          cx + (Math.random() - 0.5) * cell * 0.25,
          cy + (Math.random() - 0.5) * cell * 0.25,
          0,
        ],
        baseScale: maxScale * (0.7 + Math.random() * 0.3),
        speed: 1.0 + Math.random() * 2.4,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }
  return out;
}

function createCharAtlas(): THREE.CanvasTexture {
  const charW = 16;
  const charH = 16;
  const canvas = document.createElement("canvas");
  canvas.width = charW * CHARS.length;
  canvas.height = charH;
  const ctx = canvas.getContext("2d")!;
  // alt paper/beige bg: "#ede4d0"
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  ctx.font = `${Math.floor(charH * 0.95)}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < CHARS.length; i++) {
    ctx.fillText(CHARS[i], i * charW + charW / 2, charH / 2 + 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// TSL post-processing pass: samples scene luma into either an ASCII-char atlas
// or a procedural crosshatch (Doré/engraving) output.
function AsciiPostEffect({
  atlas,
  effect,
}: {
  atlas: THREE.Texture;
  effect: ShaderEffect;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const pipeRef = useRef<RenderPipeline | null>(null);

  useEffect(() => {
    const renderer = gl as unknown as WebGPURenderer;
    const pipe = new RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const sceneColor = scenePass.getTextureNode("output");
    const lumaWeights = vec3(0.299, 0.587, 0.114);

    const numChars = float(CHARS.length);
    const cellSize = float(CELL_SIZE);

    const asciiFn = Fn(() => {
      const res = screenSize;
      const pixelPos = uv().mul(res);
      const cellCoord = pixelPos.div(cellSize).floor();
      const cellCenterUV = cellCoord.add(0.5).mul(cellSize).div(res);

      // 5-sample max so thin spikes don't get lost between cells
      const o = cellSize.mul(0.3).div(res);
      const l0 = dot(sceneColor.sample(cellCenterUV).rgb, lumaWeights);
      const l1 = dot(sceneColor.sample(cellCenterUV.add(vec2(o, 0))).rgb, lumaWeights);
      const l2 = dot(sceneColor.sample(cellCenterUV.sub(vec2(o, 0))).rgb, lumaWeights);
      const l3 = dot(sceneColor.sample(cellCenterUV.add(vec2(0, o))).rgb, lumaWeights);
      const l4 = dot(sceneColor.sample(cellCenterUV.sub(vec2(0, o))).rgb, lumaWeights);
      const lumaMax = max(max(max(l0, l1), max(l2, l3)), l4);
      const boosted = lumaMax.pow(0.55);
      const charIdx = boosted.mul(numChars).floor().clamp(0, numChars.sub(1));

      const localUV = pixelPos.sub(cellCoord.mul(cellSize)).div(cellSize);
      const atlasU = charIdx.add(localUV.x).div(numChars);
      const atlasV = float(1).sub(localUV.y);
      const charPixel = tslTexture(atlas, vec2(atlasU, atlasV));
      return vec4(charPixel.rgb, 1);
    });

    const etchFn = Fn(() => {
      const res = screenSize;
      const pixelPos = uv().mul(res);

      const o = float(1.5).div(res);
      const l0 = dot(sceneColor.sample(uv()).rgb, lumaWeights);
      const l1 = dot(sceneColor.sample(uv().add(vec2(o.x, 0))).rgb, lumaWeights);
      const l2 = dot(sceneColor.sample(uv().sub(vec2(o.x, 0))).rgb, lumaWeights);
      const l3 = dot(sceneColor.sample(uv().add(vec2(0, o.y))).rgb, lumaWeights);
      const l4 = dot(sceneColor.sample(uv().sub(vec2(0, o.y))).rgb, lumaWeights);
      const luma = max(max(max(l0, l1), max(l2, l3)), l4);

      const spacing = float(7);
      const thickness = float(1.2);
      const big = res.x;

      const h1 = step(mod(pixelPos.x.add(pixelPos.y), spacing), thickness);
      const h2 = step(mod(pixelPos.x.sub(pixelPos.y).add(big), spacing), thickness);
      const h3 = step(
        mod(pixelPos.x.add(pixelPos.y).add(spacing.mul(0.5)), spacing),
        thickness
      );
      const h4 = step(
        mod(pixelPos.x.sub(pixelPos.y).add(big).add(spacing.mul(0.5)), spacing),
        thickness
      );

      const t1 = step(float(0.18), luma);
      const t2 = step(float(0.4), luma);
      const t3 = step(float(0.62), luma);
      const t4 = step(float(0.82), luma);

      const ink = max(max(h1.mul(t1), h2.mul(t2)), max(h3.mul(t3), h4.mul(t4)));
      // alt paper/beige: vec3(0.929, 0.894, 0.816) — #ede4d0
      const paper = vec3(1);
      return vec4(mix(paper, vec3(0), ink), 1);
    });

    const blendFn = Fn(() => {
      const cycle = time.mul(0.12); // ~8 s full cycle
      const tri = abs(fract(cycle).mul(2).sub(1)); // triangle 0→1→0
      const amt = smoothstep(float(0.35), float(0.65), tri);
      return mix(asciiFn(), etchFn(), amt);
    });

    pipe.outputNode =
      effect === "blend"
        ? blendFn()
        : effect === "etch"
        ? etchFn()
        : asciiFn();
    pipeRef.current = pipe;

    return () => {
      pipeRef.current = null;
    };
  }, [gl, scene, camera, atlas, effect]);

  useFrame(() => {
    pipeRef.current?.render();
  }, 1);

  return null;
}

// Canvas wrapper for the TSL shader pipeline (WebGPURenderer).
// Takes the scene content as children and applies the given ASCII/etch effect.
export function ShaderCanvas({
  effect,
  children,
}: {
  effect: ShaderEffect;
  children: ReactNode;
}) {
  const atlas = useMemo(() => createCharAtlas(), []);
  return (
    <Canvas
      flat
      camera={{ position: [0, 0, 3.2], fov: 50 }}
      gl={async (props) => {
        const renderer = new WebGPURenderer({
          canvas: props.canvas as HTMLCanvasElement,
          antialias: true,
        });
        await renderer.init();
        return renderer as unknown as THREE.WebGLRenderer;
      }}
    >
      <ambientLight intensity={0.6} />
      <pointLight position={[5, 5, 5]} intensity={1.4} />
      <pointLight position={[-5, -3, -2]} intensity={0.5} />
      {children}
      <AsciiPostEffect atlas={atlas} effect={effect} />
    </Canvas>
  );
}

// Canvas wrapper for the drei DOM-based AsciiRenderer (classic WebGLRenderer).
export function DreiCanvas({ children }: { children: ReactNode }) {
  return (
    <Canvas camera={{ position: [0, 0, 3.2], fov: 50 }}>
      <ambientLight intensity={0.6} />
      <pointLight position={[5, 5, 5]} intensity={1.4} />
      <pointLight position={[-5, -3, -2]} intensity={0.5} />
      {children}
      <AsciiRenderer
        fgColor="#000000"
        bgColor="#ffffff"
        characters=" .:-+*=%@#"
        invert={false}
        resolution={0.17}
      />
    </Canvas>
  );
}
