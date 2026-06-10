import * as os from "node:os"
import React from "react"
import { Box, Text } from "ink"

import { COLORS, LOGO, PRODUCT_NAME, TAGLINE, VERSION } from "../../branding.js"

function shortenPath(cwd: string): string {
	const home = os.homedir()
	return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

export function Header({ cwd, modelName }: { cwd: string; modelName: string }) {
	const logoLines = LOGO.split("\n").filter((line) => line.trim().length > 0)
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={COLORS.accent}
				paddingX={2}
				alignSelf="flex-start"
			>
				{logoLines.map((line, i) => (
					<Text key={i} bold color={COLORS.primary}>
						{line}
					</Text>
				))}
				<Text> </Text>
				<Text>
					<Text bold color={COLORS.primary}>
						{PRODUCT_NAME}
					</Text>
					<Text dimColor> v{VERSION}</Text>
					<Text color={COLORS.thinking}> ✦ </Text>
					<Text dimColor italic>
						{TAGLINE}
					</Text>
				</Text>
				<Text> </Text>
				<Text>
					<Text dimColor>model </Text>
					<Text color={COLORS.accent}>{modelName}</Text>
				</Text>
				<Text>
					<Text dimColor>cwd </Text>
					<Text>{shortenPath(cwd)}</Text>
				</Text>
			</Box>
			<Text dimColor>
				{"  "}/help commands · shift+tab approvals · ctrl+o thinking · esc interrupt · ctrl+c quit
			</Text>
		</Box>
	)
}
