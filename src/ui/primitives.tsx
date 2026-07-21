import React, { createContext, useContext } from "react"
import { createTextAttributes, type KeyEvent, type PasteMetadata } from "@opentui/core"
import {
	useKeyboard,
	usePaste,
	useRenderer,
	type BoxProps as NativeBoxProps,
	type TextProps as NativeTextProps,
} from "@opentui/react"

import { resolveThemeColor, useTheme } from "./theme.js"

export interface InputKey {
	upArrow: boolean
	downArrow: boolean
	leftArrow: boolean
	rightArrow: boolean
	pageUp: boolean
	pageDown: boolean
	return: boolean
	escape: boolean
	tab: boolean
	backspace: boolean
	delete: boolean
	ctrl: boolean
	shift: boolean
	meta: boolean
}

type BorderStyle = NativeBoxProps["borderStyle"] | "round"

export interface BoxProps extends Omit<NativeBoxProps, "borderStyle"> {
	borderStyle?: BorderStyle
}

export function Box({
	borderStyle,
	borderColor,
	backgroundColor,
	flexDirection = "row",
	children,
	...props
}: BoxProps) {
	const theme = useTheme()
	const nativeBorderStyle = borderStyle === "round" ? "rounded" : borderStyle
	return (
		<box
			{...props}
			flexDirection={flexDirection}
			border={nativeBorderStyle ? (props.border ?? true) : props.border}
			borderStyle={nativeBorderStyle}
			borderColor={resolveThemeColor(typeof borderColor === "string" ? borderColor : undefined, theme) ?? borderColor}
			backgroundColor={resolveThemeColor(
				typeof backgroundColor === "string" ? backgroundColor : undefined,
				theme,
			) ?? backgroundColor}
		>
			{children}
		</box>
	)
}

export interface TextProps extends Omit<NativeTextProps, "fg" | "bg" | "attributes" | "wrapMode" | "children"> {
	children?: React.ReactNode
	color?: string
	backgroundColor?: string
	bold?: boolean
	italic?: boolean
	underline?: boolean
	dimColor?: boolean
	strikethrough?: boolean
	wrap?: "wrap" | "truncate" | "truncate-start"
}

const TextNestingContext = createContext(false)

export function Text({
	children,
	color,
	backgroundColor,
	bold,
	italic,
	underline,
	dimColor,
	strikethrough,
	wrap,
	...props
}: TextProps) {
	const nested = useContext(TextNestingContext)
	const theme = useTheme()
	const fg = resolveThemeColor(color, theme)
	const bg = resolveThemeColor(backgroundColor, theme)
	const attributes = createTextAttributes({
		bold,
		italic,
		underline,
		dim: dimColor,
		strikethrough,
	})

	if (nested) {
		return (
			<span fg={fg} bg={bg} attributes={attributes}>
				{children}
			</span>
		)
	}

	return (
		<TextNestingContext.Provider value>
			<text
				{...props}
				fg={fg ?? theme.primary}
				bg={bg}
				attributes={attributes}
				wrapMode={wrap === "truncate" || wrap === "truncate-start" ? "none" : "word"}
				truncate={wrap === "truncate" || wrap === "truncate-start"}
			>
				{children}
			</text>
		</TextNestingContext.Provider>
	)
}

function inputKey(event: KeyEvent): InputKey {
	const name = event.name.toLowerCase()
	// Outside the Kitty keyboard protocol, several terminals encode
	// Shift+Enter as LF while plain Enter is CR. OpenTUI exposes that LF as a
	// `linefeed` key with no shift modifier, so preserve the distinction here.
	const isLinefeed = name === "linefeed"
	return {
		upArrow: name === "up",
		downArrow: name === "down",
		leftArrow: name === "left",
		rightArrow: name === "right",
		pageUp: name === "pageup" || name === "page_up",
		pageDown: name === "pagedown" || name === "page_down",
		return: name === "return" || name === "enter" || isLinefeed,
		escape: name === "escape" || name === "esc",
		tab: name === "tab",
		backspace: name === "backspace",
		delete: name === "delete",
		ctrl: event.ctrl,
		shift: event.shift || isLinefeed,
		meta: event.meta || event.option,
	}
}

function inputText(event: KeyEvent): string {
	const name = event.name.toLowerCase()
	if (name === "space") return " "
	if ((event.ctrl || event.meta || event.option) && event.name.length === 1) return event.name
	if (event.sequence && !/^[\u0000-\u001f\u007f\u001b]/.test(event.sequence)) return event.sequence
	return event.name.length === 1 ? event.name : ""
}

export function useInput(
	handler: (input: string, key: InputKey) => void,
	options: {
		isActive?: boolean
		/** Return true when the caller consumed the paste. */
		onPaste?: (input: string, metadata?: PasteMetadata) => boolean
	} = {},
) {
	const active = options.isActive ?? true
	useKeyboard((event) => {
		if (!active) return
		handler(inputText(event), inputKey(event))
	})
	usePaste((event) => {
		if (!active) return
		const input = new TextDecoder().decode(event.bytes)
		if (options.onPaste?.(input, event.metadata)) return
		handler(input, {
			upArrow: false,
			downArrow: false,
			leftArrow: false,
			rightArrow: false,
			pageUp: false,
			pageDown: false,
			return: false,
			escape: false,
			tab: false,
			backspace: false,
			delete: false,
			ctrl: false,
			shift: false,
			meta: false,
		})
	})
}

export function useApp() {
	const renderer = useRenderer()
	return { exit: () => renderer.destroy() }
}
