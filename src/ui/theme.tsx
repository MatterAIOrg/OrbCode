import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRenderer } from "@opentui/react";

import type { OrbCodeThemeMode } from "../config/settings.js";

export type { OrbCodeThemeMode } from "../config/settings.js";

export interface OrbCodeTheme {
  mode: OrbCodeThemeMode;
  background: string;
  panel: string;
  panelRaised: string;
  selection: string;
  primary: string;
  accent: string;
  dim: string;
  error: string;
  warning: string;
  success: string;
  thinking: string;
  user: string;
  inputBorder: string;
  inputBorderInactive: string;
  diffAddedBackground: string;
  diffRemovedBackground: string;
}

export const DARK_THEME: OrbCodeTheme = {
  mode: "dark",
  background: "#141414",
  panel: "#151B20",
  panelRaised: "#1D252C",
  selection: "#203945",
  primary: "#E7F2F5",
  accent: "#c4fdff",
  dim: "#81939B",
  error: "#E34671",
  warning: "#F2C94C",
  success: "#3FA266",
  thinking: "#c4fdff",
  user: "#A5F3F6",
  inputBorder: "#535353",
  inputBorderInactive: "#52646C",
  diffAddedBackground: "#3FA2660D",
  diffRemovedBackground: "#E346710D",
};

export const LIGHT_THEME: OrbCodeTheme = {
  mode: "light",
  background: "#FFFFFF",
  panel: "#F1F3F5",
  panelRaised: "#E5E7EB",
  selection: "#D4EAF1",
  primary: "#12262F",
  accent: "#3a5455",
  dim: "#637780",
  error: "#E34671",
  warning: "#9A6500",
  success: "#3FA266",
  thinking: "#3a5455",
  user: "#293c3d",
  inputBorder: "#535353",
  inputBorderInactive: "#91A4AC",
  diffAddedBackground: "#3FA2660D",
  diffRemovedBackground: "#E346710D",
};

const ThemeContext = createContext<OrbCodeTheme>(DARK_THEME);
const ThemeModeContext = createContext<{
  mode: OrbCodeThemeMode;
  setMode: (mode: OrbCodeThemeMode) => void;
}>({ mode: "dark", setMode: () => {} });

export function ThemeProvider({
  children,
  initialMode,
}: React.PropsWithChildren<{ initialMode: OrbCodeThemeMode }>) {
  const renderer = useRenderer();
  const [mode, setMode] = useState<OrbCodeThemeMode>(initialMode);
  const theme = mode === "light" ? LIGHT_THEME : DARK_THEME;
  const modeValue = useMemo(() => ({ mode, setMode }), [mode]);

  useEffect(() => {
    renderer.setBackgroundColor(theme.background);
  }, [renderer, theme.background]);

  return (
    <ThemeModeContext.Provider value={modeValue}>
      <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
    </ThemeModeContext.Provider>
  );
}

export function useTheme(): OrbCodeTheme {
  return useContext(ThemeContext);
}

export function useThemeMode() {
  return useContext(ThemeModeContext);
}

const TOKEN_PREFIX = "$orbcode.";

export function resolveThemeColor(
  color: string | undefined,
  theme: OrbCodeTheme,
): string | undefined {
  if (!color?.startsWith(TOKEN_PREFIX)) return color;
  const key = color.slice(TOKEN_PREFIX.length) as keyof OrbCodeTheme;
  const resolved = theme[key];
  return typeof resolved === "string" ? resolved : undefined;
}
