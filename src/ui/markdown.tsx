import React from "react"

import { COLORS } from "../branding.js"
import { Text } from "./primitives.js"

const INLINE_MARKDOWN = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|(?<![\w*])\*[^*\n]+\*(?![\w*])|\[[^\]]+\]\([^)]+\))/g

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
	const nodes: React.ReactNode[] = []
	let cursor = 0
	let match: RegExpExecArray | null
	INLINE_MARKDOWN.lastIndex = 0
	let index = 0

	while ((match = INLINE_MARKDOWN.exec(text))) {
		if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
		const token = match[0]
		const key = `${keyPrefix}-${index++}`
		if (token.startsWith("`")) {
			nodes.push(<Text key={key} color={COLORS.accent}>{token.slice(1, -1)}</Text>)
		} else if (token.startsWith("**") || token.startsWith("__")) {
			nodes.push(<Text key={key} bold>{token.slice(2, -2)}</Text>)
		} else if (token.startsWith("*")) {
			nodes.push(<Text key={key} italic>{token.slice(1, -1)}</Text>)
		} else {
			const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
			if (link) {
				nodes.push(
					<React.Fragment key={key}>
						{link[1]} <Text color={COLORS.dim} underline>{link[2]}</Text>
					</React.Fragment>,
				)
			}
		}
		cursor = match.index + token.length
	}

	if (cursor < text.length) nodes.push(text.slice(cursor))
	return nodes
}

/** Lightweight markdown rendered as OpenTUI-native styled text nodes. */
export function renderMarkdown(markdown: string): React.ReactNode {
	const output: React.ReactNode[] = []
	let inCodeBlock = false

	markdown.split("\n").forEach((line, lineIndex, lines) => {
		const fence = /^\s*```(.*)$/.exec(line)
		let content: React.ReactNode

		if (fence) {
			if (!inCodeBlock) {
				inCodeBlock = true
				const language = fence[1].trim()
				content = <Text color={COLORS.dim}>{language ? `╭─ ${language}` : "╭─"}</Text>
			} else {
				inCodeBlock = false
				content = <Text color={COLORS.dim}>╰─</Text>
			}
		} else if (inCodeBlock) {
			content = (
				<React.Fragment>
					<Text color={COLORS.dim}>│ </Text>
					<Text color={COLORS.accent}>{line}</Text>
				</React.Fragment>
			)
		} else {
			const header = /^(#{1,6})\s+(.*)$/.exec(line)
			const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line)
			const ordered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line)
			const quote = /^>\s?(.*)$/.exec(line)

			if (header) {
				content = <Text bold underline>{renderInline(header[2], `h-${lineIndex}`)}</Text>
			} else if (bullet) {
				content = <>{bullet[1]}• {renderInline(bullet[2], `b-${lineIndex}`)}</>
			} else if (ordered) {
				content = <>{ordered[1]}{ordered[2]}. {renderInline(ordered[3], `o-${lineIndex}`)}</>
			} else if (quote) {
				content = <Text color={COLORS.dim}>│ {renderInline(quote[1], `q-${lineIndex}`)}</Text>
			} else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
				content = <Text color={COLORS.dim}>{"─".repeat(40)}</Text>
			} else {
				content = <>{renderInline(line, `p-${lineIndex}`)}</>
			}
		}

		output.push(<React.Fragment key={lineIndex}>{content}</React.Fragment>)
		if (lineIndex < lines.length - 1) output.push("\n")
	})

	return <>{output}</>
}
