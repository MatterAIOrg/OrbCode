import React, { createContext, useContext, useEffect, useState } from "react"
import { CliRenderEvents, type ThemeMode } from "@opentui/core"
import { useRenderer } from "@opentui/react"

export interface OrbCodeTheme {
	mode: ThemeMode
	background: string
	panel: string
	panelRaised: string
	selection: string
	primary: string
	accent: string
	dim: string
	error: string
	warning: string
	success: string
	thinking: string
	user: string
	inputBorder: string
	inputBorderInactive: string
	diffAddedBackground: string
	diffRemovedBackground: string
}

export const DARK_THEME: OrbCodeTheme = {
	mode: "dark",
	background: "#071A22",
	panel: "#151B20",
	panelRaised: "#1D252C",
	selection: "#203945",
	primary: "#E7F2F5",
	accent: "#38BDE8",
	dim: "#81939B",
	error: "#F0627E",
	warning: "#F2C94C",
	success: "#43C987",
	thinking: "#36C2C9",
	user: "#A5F3F6",
	inputBorder: "#38BDE8",
	inputBorderInactive: "#52646C",
	diffAddedBackground: "#102C25",
	diffRemovedBackground: "#321A22",
}

export const LIGHT_THEME: OrbCodeTheme = {
	mode: "light",
	background: "#EEF4F6",
	panel: "#FFFFFF",
	panelRaised: "#E2ECEF",
	selection: "#D4EAF1",
	primary: "#12262F",
	accent: "#087FA8",
	dim: "#637780",
	error: "#C82E52",
	warning: "#9A6500",
	success: "#18794E",
	thinking: "#087F87",
	user: "#075E68",
	inputBorder: "#087FA8",
	inputBorderInactive: "#91A4AC",
	diffAddedBackground: "#DDF4E8",
	diffRemovedBackground: "#FBE3E8",
}

const ThemeContext = createContext<OrbCodeTheme>(DARK_THEME)

function configuredThemeMode(): ThemeMode | undefined {
	const value = process.env.ORBCODE_THEME?.trim().toLowerCase()
	return value === "dark" || value === "light" ? value : undefined
}

export function ThemeProvider({ children }: React.PropsWithChildren) {
	const renderer = useRenderer()
	const forcedMode = configuredThemeMode()
	const [mode, setMode] = useState<ThemeMode>(() => forcedMode ?? renderer.themeMode ?? "dark")
	const theme = mode === "light" ? LIGHT_THEME : DARK_THEME

	useEffect(() => {
		if (forcedMode) return
		let active = true
		const onThemeMode = (next: ThemeMode) => setMode(next)
		renderer.on(CliRenderEvents.THEME_MODE, onThemeMode)
		void renderer.waitForThemeMode(250).then((next) => {
			if (active && next) setMode(next)
		})
		return () => {
			active = false
			renderer.off(CliRenderEvents.THEME_MODE, onThemeMode)
		}
	}, [forcedMode, renderer])

	useEffect(() => {
		renderer.setBackgroundColor(theme.background)
	}, [renderer, theme.background])

	return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
}

export function useTheme(): OrbCodeTheme {
	return useContext(ThemeContext)
}

const TOKEN_PREFIX = "$orbcode."

export function resolveThemeColor(color: string | undefined, theme: OrbCodeTheme): string | undefined {
	if (!color?.startsWith(TOKEN_PREFIX)) return color
	const key = color.slice(TOKEN_PREFIX.length) as keyof OrbCodeTheme
	const resolved = theme[key]
	return typeof resolved === "string" ? resolved : undefined
}
