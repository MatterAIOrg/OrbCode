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

// Neutral black/white/grey foundation with explicit semantic accents. All
// values are hex so the TUI never falls back to terminal-defined colors.
// Hierarchy:
//   primary  #ffffff  — main text, header chrome
//   accent   #d0d0d0  — secondary emphasis (header model, selected rows)
//   thinking #a8a8a8  — model-reasoning text
//   dim      #7a7a7a  — supporting / hint text
//   error    #E34671  — errors, removals, dangerous actions
//   success  #3FA266  — success states, additions, auto-approval
//   warning  #E2CE76  — confirmations and edit approval
export const COLORS = {
  primary: "#ffffff",
  accent: "#d0d0d0",
  dim: "#7a7a7a",
  error: "#E34671",
  warning: "#E2CE76",
  success: "#3FA266",
  thinking: "#a8a8a8",
  user: "#ffffff",
  userBg: "#2a2a2a",
  popupBg: "#242424",
  inputBorder: "#808080",
  inputBorderInactive: "#3d3d3d",
  orbitalOuter: "#06E1E7",
  orbitalInner: "#8BF4F7",
  bg: "#1a1a1a",
} as const;

/**
 * Terminal-sized interpretation of design/orbital.svg. Characters identify
 * its outer cyan field, inner orbit, and white core; Header maps them to
 * solid block cells using the source artwork's colors.
 */
export const ORBITAL_MARK = [
  "    ooooo",
  "  ooooooooo",
  "oooooiiiooooo",
  "oiiiiwwwwiiii",
  " oiiwwwwwwiio",
  "   oiwwwwio",
] as const;
