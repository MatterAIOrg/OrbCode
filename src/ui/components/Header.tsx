import React from "react"
import { Box, Text } from "ink"

import { COLORS, LOGO, PRODUCT_NAME, TAGLINE, VERSION } from "../../branding.js"

export function Header({ cwd, modelName }: { cwd: string; modelName: string }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text color={COLORS.primary}>{LOGO}</Text>
			<Box>
				<Text bold color={COLORS.primary}>
					{PRODUCT_NAME}
				</Text>
				<Text dimColor> v{VERSION} — {TAGLINE}</Text>
			</Box>
			<Text dimColor>
				model: {modelName} · cwd: {cwd}
			</Text>
			<Text dimColor>/help for commands · Esc to interrupt · Ctrl+C to quit</Text>
		</Box>
	)
}
