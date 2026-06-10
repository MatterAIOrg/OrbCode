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

export const COLORS = {
  primary: "#c4fdff",
  accent: "#4EC9B0",
  dim: "gray",
  error: "#e86464",
  warning: "#e2ce76",
  success: "#43df94",
  thinking: "#8cd3de",
  user: "#569CD6",
} as const;

export const LOGO = `
  ___         _       ____             _
 / _ \\  _ __ | |__   / ___|  ___    __| |  ___
| | | || '__|| '_ \\ | |     / _ \\  / _\` | / _ \\
| |_| || |   | |_) || |___ | (_) || (_| ||  __/
 \\___/ |_|   |_.__/  \\____| \\___/  \\__,_| \\___|
`;
