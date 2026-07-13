import chalk from "chalk"

/** Render inline markdown (bold, italic, code, links) to ANSI. */
function renderInline(text: string): string {
	let out = text
	// inline code first so other patterns don't fire inside it
	out = out.replace(/`([^`]+)`/g, (_, code) => chalk.cyan(code))
	out = out.replace(/\*\*([^*]+)\*\*/g, (_, t) => chalk.bold(t))
	out = out.replace(/__([^_]+)__/g, (_, t) => chalk.bold(t))
	out = out.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, (_, t) => chalk.italic(t))
	out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `${label} ${chalk.dim.underline(url)}`)
	return out
}

/** Lightweight markdown → ANSI renderer for terminal chat output. */
export function renderMarkdown(markdown: string): string {
	const lines = markdown.split("\n")
	const out: string[] = []
	let inCodeBlock = false

	for (const line of lines) {
		const fence = line.match(/^\s*```(.*)$/)
		if (fence) {
			if (!inCodeBlock) {
				inCodeBlock = true
				const lang = fence[1].trim()
				out.push(chalk.dim(lang ? `╭─ ${lang}` : "╭─"))
			} else {
				inCodeBlock = false
				out.push(chalk.dim("╰─"))
			}
			continue
		}

		if (inCodeBlock) {
			out.push(chalk.dim("│ ") + chalk.cyan(line))
			continue
		}

		const header = line.match(/^(#{1,6})\s+(.*)$/)
		if (header) {
			out.push(chalk.bold.underline(renderInline(header[2])))
			continue
		}

		const bullet = line.match(/^(\s*)[-*]\s+(.*)$/)
		if (bullet) {
			out.push(`${bullet[1]}• ${renderInline(bullet[2])}`)
			continue
		}

		const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/)
		if (ordered) {
			out.push(`${ordered[1]}${ordered[2]}. ${renderInline(ordered[3])}`)
			continue
		}

		const quote = line.match(/^>\s?(.*)$/)
		if (quote) {
			out.push(chalk.dim(`│ ${renderInline(quote[1])}`))
			continue
		}

		if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
			out.push(chalk.dim("─".repeat(40)))
			continue
		}

		out.push(renderInline(line))
	}

	return out.join("\n")
}
