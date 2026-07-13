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

// Theme-neutral terminal palette. Neutral content inherits the terminal's
// foreground. Success and error retain OrbCode's brand colors consistently
// across themes; the remaining accents use the terminal's named ANSI palette.
export const COLORS = {
  primary: undefined,
  accent: "cyan",
  dim: "gray",
  error: "#E34671",
  warning: "yellow",
  success: "#3FA266",
  thinking: "cyan",
  user: undefined,
  inputBorder: "gray",
  inputBorderInactive: "gray",
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
