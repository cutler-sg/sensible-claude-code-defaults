import bundled from "../../manifest/defaults.json";
import type { Manifest } from "./types.js";

/** The offline fallback shipped inside the VSIX (FR-3.1). */
export const BUNDLED_MANIFEST: Manifest = bundled as Manifest;
