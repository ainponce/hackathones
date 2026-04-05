import { useControls } from "leva";
import SparkleDrei from "./loader-variants/SparkleDrei";
import SparkleShader from "./loader-variants/SparkleShader";
import SparkleField from "./loader-variants/SparkleField";
import SparkleEtch from "./loader-variants/SparkleEtch";
import SparkleFieldEtch from "./loader-variants/SparkleFieldEtch";
import SparkleBlend from "./loader-variants/SparkleBlend";

type ModelKind =
  | "sparkle"
  | "sparkle-shader"
  | "sparkle-field"
  | "sparkle-etch"
  | "sparkle-field-etch"
  | "sparkle-blend";

export default function AsciiTorus() {
  const { model } = useControls({
    model: {
      value: "sparkle" as ModelKind,
      options: {
        sparkle: "sparkle",
        "sparkle-shader": "sparkle-shader",
        "sparkle-field": "sparkle-field",
        "sparkle-etch": "sparkle-etch",
        "sparkle-field-etch": "sparkle-field-etch",
        "sparkle-blend": "sparkle-blend",
      } as Record<string, ModelKind>,
      label: "model",
    },
  });

  switch (model) {
    case "sparkle":
      return <SparkleDrei />;
    case "sparkle-shader":
      return <SparkleShader />;
    case "sparkle-field":
      return <SparkleField />;
    case "sparkle-etch":
      return <SparkleEtch />;
    case "sparkle-field-etch":
      return <SparkleFieldEtch />;
    case "sparkle-blend":
      return <SparkleBlend />;
  }
}
