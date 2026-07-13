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

// Light neutral foundation with explicit semantic accents. The terminal's
// configured default foreground/background remain untouched; these values are
// used only for TUI content and intentional surfaces such as prompts/popups.
// Hierarchy:
//   primary  #1f2328  — main text, header chrome
//   accent   #3f4750  — secondary emphasis (header model, selected rows)
//   thinking #59636e  — model-reasoning text
//   dim      #6e7781  — supporting / hint text
//   error    #cf222e  — errors, removals, dangerous actions
//   success  #1a7f37  — success states, additions, auto-approval
//   warning  #9a6700  — confirmations and edit approval
export const COLORS = {
  primary: "#1f2328",
  accent: "#3f4750",
  dim: "#6e7781",
  error: "#cf222e",
  warning: "#9a6700",
  success: "#1a7f37",
  thinking: "#59636e",
  user: "#1f2328",
  userBg: "#eaeef2",
  popupBg: "#f6f8fa",
  inputBorder: "#57606a",
  inputBorderInactive: "#afb8c1",
  orbitalOuter: "#007f86",
  orbitalInner: "#009aa3",
  bg: "#ffffff",
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
