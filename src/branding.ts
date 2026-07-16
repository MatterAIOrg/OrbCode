import * as fs from "node:fs";

export const PRODUCT_NAME = "OrbCode CLI";
export const BIN_NAME = "orbcode";
export const VERSION = (() => {
  try {
    // dist/branding.js -> ../package.json
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    return (pkg.version as string) || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
export const TAGLINE = "powered by Axon models by MatterAI";

// Semantic color tokens. The OpenTUI primitives resolve these against the
// active OrbCode theme, so components never inherit terminal-defined colors.
// Keeping these as tokens also lets the complete UI switch themes atomically.
export const COLORS = {
  primary: "$orbcode.primary",
  accent: "$orbcode.accent",
  dim: "$orbcode.dim",
  error: "$orbcode.error",
  warning: "$orbcode.warning",
  success: "$orbcode.success",
  thinking: "$orbcode.thinking",
  user: "$orbcode.user",
  inputBorder: "$orbcode.inputBorder",
  inputBorderInactive: "$orbcode.inputBorderInactive",
  diffAddedBackground: "$orbcode.diffAddedBackground",
  diffRemovedBackground: "$orbcode.diffRemovedBackground",
} as const;

// Immutable company-logo colors from the OrbCode artwork. Keep these separate
// from the terminal theme so light/dark palettes can never recolor the logo.
export const ORBITAL_COLORS = {
  outer: "#06E1E7",
  inner: "#8BF4F7",
  core: "#ffffff",
} as const;

/**
 * Terminal-sized interpretation of design/orbital.svg. Characters identify
 * its outer cyan field, inner orbit, and white core; Header maps them to
 * solid block cells using the immutable source-artwork colors above.
 */
export const ORBITAL_MARK = [
  "    ooooo",
  "  ooooooooo",
  "oooooiiiooooo",
  "oiiiiwwwwiiii",
  " oiiwwwwwwiio",
  "   oiwwwwio",
] as const;
