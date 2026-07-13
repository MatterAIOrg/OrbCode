import * as os from "node:os"
import React from "react"
import { Box, Text } from "ink"

import { COLORS, ORBITAL_COLORS, ORBITAL_MARK, PRODUCT_NAME, TAGLINE, VERSION } from "../../branding.js"

const MARK_WIDTH = 13
const META_LABEL_WIDTH = 11
const ACTION_LABEL_WIDTH = 10
const FIRST_ACTION_COLUMN_WIDTH = 30

function shortenPath(cwd: string): string {
	const home = os.homedir()
	return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

function OrbitalMark() {
	return (
		<Box flexDirection="column" width={MARK_WIDTH} alignItems="flex-start">
			{ORBITAL_MARK.map((line, row) => (
				<Text key={row}>
					{Array.from(line.matchAll(/(.)\1*/g), ([run]) => run).map((run, index) => {
						const pixel = run[0]
						if (pixel === " ") return <Text key={index}>{run}</Text>
						const color =
							pixel === "o"
								? ORBITAL_COLORS.outer
								: pixel === "i"
									? ORBITAL_COLORS.inner
									: ORBITAL_COLORS.core
						const glyph = row === 0 ? "▄" : row === ORBITAL_MARK.length - 1 ? "▀" : "█"
						return <Text key={index} color={color}>{glyph.repeat(run.length)}</Text>
					})}
				</Text>
			))}
		</Box>
	)
}

function MetadataRow({ label, value }: { label: string; value: string }) {
	return (
		<Text>
			<Text color={COLORS.dim}>{label.toUpperCase().padEnd(META_LABEL_WIDTH)}</Text>
			<Text color={COLORS.accent}>{value}</Text>
		</Text>
	)
}

function ActionCell({ command, label, width }: { command: string; label: string; width?: number }) {
	return (
		<Box width={width}>
			<Text>
				<Text color={COLORS.primary}>{command.padEnd(ACTION_LABEL_WIDTH)}</Text>
				<Text color={COLORS.dim}>{label}</Text>
			</Text>
		</Box>
	)
}

export function Header({ cwd, modelName }: { cwd: string; modelName: string }) {
	return (
		<Box flexDirection="column" width="100%" alignItems="center" marginBottom={1}>
			<Box flexDirection="column" width="100%" paddingX={2}>
				<Box flexDirection="row" columnGap={4}>
					<OrbitalMark />
					<Box flexDirection="column" flexGrow={1} minWidth={0}>
						<Text>
							<Text bold color={COLORS.primary}>{PRODUCT_NAME}</Text>
							<Text color={COLORS.dim}> / v{VERSION}</Text>
						</Text>
						<Text color={COLORS.dim} italic>{TAGLINE}</Text>
						<Text> </Text>
						<MetadataRow label="model" value={modelName} />
						<MetadataRow label="workspace" value={shortenPath(cwd)} />
					</Box>
				</Box>
				<Box flexDirection="row" columnGap={2} marginTop={1}>
					<ActionCell command="/new" label="fresh conversation" width={FIRST_ACTION_COLUMN_WIDTH} />
					<ActionCell command="/resume" label="continue a session" />
				</Box>
				<Box flexDirection="row" columnGap={2}>
					<ActionCell command="/model" label="switch active model" width={FIRST_ACTION_COLUMN_WIDTH} />
					<ActionCell command="/help" label="all commands" />
				</Box>
				<Box marginTop={1}>
					<Text color={COLORS.dim}>
						shift+tab approvals · ctrl+o thinking · esc interrupt · ctrl+d exit
					</Text>
				</Box>
			</Box>
		</Box>
	)
}
