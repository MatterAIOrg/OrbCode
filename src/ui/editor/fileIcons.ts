import {
  getIconForDirectoryPath,
  getIconForFilePath,
  type MaterialIcon,
} from "vscode-material-icons";

export interface TerminalMaterialIcon {
  /** The resolved vscode-material-icons asset name. */
  materialIcon: MaterialIcon;
  /** A one-cell Nerd Font equivalent suitable for OpenTUI text rendering. */
  glyph: string;
  /** Primary color from the corresponding Material Icon Theme family. */
  color: string;
}

interface IconPresentation {
  glyph: string;
  color: string;
}

const DEFAULT_FILE: IconPresentation = {
  glyph: "",
  color: "#90A4AE",
};

const FILE_PRESENTATIONS: Readonly<Record<string, IconPresentation>> = {
  typescript: { glyph: "", color: "#0288D1" },
  "typescript-def": { glyph: "", color: "#0288D1" },
  react_ts: { glyph: "", color: "#0288D1" },
  javascript: { glyph: "", color: "#FFCA28" },
  "javascript-map": { glyph: "", color: "#FFCA28" },
  react: { glyph: "", color: "#00BCD4" },
  nodejs: { glyph: "", color: "#8BC34A" },
  nodejs_alt: { glyph: "", color: "#8BC34A" },
  npm: { glyph: "", color: "#CB3837" },
  pnpm: { glyph: "", color: "#F9AD00" },
  yarn: { glyph: "", color: "#2C8EBB" },
  bun: { glyph: "", color: "#FBF0DF" },
  html: { glyph: "", color: "#E44D26" },
  css: { glyph: "", color: "#42A5F5" },
  sass: { glyph: "", color: "#EC407A" },
  less: { glyph: "", color: "#0277BD" },
  postcss: { glyph: "", color: "#DD3A0A" },
  tailwindcss: { glyph: "󱏿", color: "#42A5F5" },
  json: { glyph: "", color: "#F9A825" },
  hjson: { glyph: "", color: "#F9A825" },
  json5: { glyph: "", color: "#F9A825" },
  yaml: { glyph: "", color: "#F9A825" },
  xml: { glyph: "󰗀", color: "#FFB300" },
  markdown: { glyph: "", color: "#42A5F5" },
  readme: { glyph: "", color: "#42A5F5" },
  mdx: { glyph: "", color: "#42A5F5" },
  document: { glyph: "", color: "#42A5F5" },
  text: { glyph: "", color: "#90A4AE" },
  python: { glyph: "", color: "#3C78AA" },
  go: { glyph: "", color: "#00ACC1" },
  "go-mod": { glyph: "", color: "#00ACC1" },
  rust: { glyph: "", color: "#FF7043" },
  php: { glyph: "", color: "#7E57C2" },
  java: { glyph: "", color: "#F44336" },
  jar: { glyph: "", color: "#F44336" },
  kotlin: { glyph: "", color: "#7E57C2" },
  swift: { glyph: "", color: "#F05138" },
  ruby: { glyph: "", color: "#E53935" },
  c: { glyph: "", color: "#0288D1" },
  h: { glyph: "", color: "#7E57C2" },
  cpp: { glyph: "", color: "#0288D1" },
  hpp: { glyph: "", color: "#7E57C2" },
  csharp: { glyph: "󰌛", color: "#7CB342" },
  fsharp: { glyph: "", color: "#378BBA" },
  lua: { glyph: "", color: "#42A5F5" },
  dart: { glyph: "", color: "#00B4AB" },
  elixir: { glyph: "", color: "#7E57C2" },
  erlang: { glyph: "", color: "#E91E63" },
  haskell: { glyph: "", color: "#7E57C2" },
  scala: { glyph: "", color: "#E53935" },
  r: { glyph: "󰟔", color: "#1976D2" },
  vue: { glyph: "", color: "#41B883" },
  svelte: { glyph: "", color: "#FF3E00" },
  astro: { glyph: "", color: "#FF5D01" },
  angular: { glyph: "", color: "#DD0031" },
  next: { glyph: "", color: "#ECEFF1" },
  nuxt: { glyph: "󱄆", color: "#00DC82" },
  vite: { glyph: "", color: "#FFAB00" },
  vitest: { glyph: "", color: "#729B1B" },
  jest: { glyph: "", color: "#C21325" },
  playwright: { glyph: "󰖟", color: "#45BA4B" },
  git: { glyph: "", color: "#E64A19" },
  github: { glyph: "", color: "#ECEFF1" },
  gitlab: { glyph: "", color: "#E24329" },
  docker: { glyph: "", color: "#0087C9" },
  kubernetes: { glyph: "󱃾", color: "#326CE5" },
  terraform: { glyph: "󱁢", color: "#7B42BC" },
  database: { glyph: "", color: "#FFCA28" },
  console: { glyph: "", color: "#90A4AE" },
  powershell: { glyph: "󰨊", color: "#0288D1" },
  lock: { glyph: "", color: "#F9A825" },
  settings: { glyph: "", color: "#90A4AE" },
  tsconfig: { glyph: "", color: "#0288D1" },
  jsconfig: { glyph: "", color: "#FFCA28" },
  eslint: { glyph: "", color: "#7C4DFF" },
  prettier: { glyph: "", color: "#56B3B4" },
  editorconfig: { glyph: "", color: "#ECEFF1" },
  pdf: { glyph: "", color: "#F44336" },
  image: { glyph: "", color: "#AB47BC" },
  svg: { glyph: "󰜡", color: "#FFB300" },
  video: { glyph: "", color: "#E91E63" },
  audio: { glyph: "", color: "#7E57C2" },
  zip: { glyph: "", color: "#AFB42B" },
  certificate: { glyph: "󰄤", color: "#F9A825" },
  key: { glyph: "", color: "#F9A825" },
  font: { glyph: "", color: "#EC407A" },
  diff: { glyph: "", color: "#90A4AE" },
  search: { glyph: "", color: "#42A5F5" },
};

const FOLDER_COLORS: Readonly<Record<string, string>> = {
  "folder-src": "#4CAF50",
  "folder-components": "#C0CA33",
  "folder-github": "#546E7A",
  "folder-git": "#E64A19",
  "folder-node": "#8BC34A",
  "folder-typescript": "#0288D1",
  "folder-javascript": "#FFCA28",
  "folder-css": "#42A5F5",
  "folder-sass": "#EC407A",
  "folder-images": "#AB47BC",
  "folder-test": "#F9A825",
  "folder-config": "#78909C",
  "folder-docs": "#42A5F5",
  "folder-docker": "#0087C9",
  "folder-database": "#FFCA28",
  "folder-api": "#00ACC1",
  "folder-app": "#7E57C2",
  "folder-public": "#26A69A",
  "folder-layout": "#66BB6A",
  "folder-hook": "#AB47BC",
  "folder-utils": "#78909C",
};

function filePresentation(materialIcon: MaterialIcon): IconPresentation {
  const exact = FILE_PRESENTATIONS[materialIcon];
  if (exact) return exact;

  if (materialIcon.startsWith("test-")) {
    return { glyph: "󰙨", color: "#F9A825" };
  }
  if (materialIcon.includes("config")) {
    return { glyph: "", color: "#90A4AE" };
  }
  if (materialIcon.includes("light")) {
    return { glyph: "", color: "#B0BEC5" };
  }
  return DEFAULT_FILE;
}

/**
 * Uses the same filename resolver as MatterCode's mention chips. OpenTUI
 * renders text cells rather than SVG images, so each resolved Material icon is
 * represented by its closest Nerd Font glyph and original theme-family color.
 */
export function terminalFileIcon(path: string): TerminalMaterialIcon {
  const materialIcon = getIconForFilePath(path);
  return {
    materialIcon,
    ...filePresentation(materialIcon),
  };
}

export function terminalFolderIcon(
  path: string,
  expanded = false,
): TerminalMaterialIcon {
  const materialIcon = getIconForDirectoryPath(path);
  return {
    materialIcon,
    glyph: expanded ? "" : "",
    color: FOLDER_COLORS[materialIcon] ?? "#90A4AE",
  };
}
