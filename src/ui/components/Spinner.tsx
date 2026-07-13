import React, { useEffect, useState } from "react"
import { Text } from "ink"

import { COLORS } from "../../branding.js"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function Spinner({ label }: { label: string }) {
	const [frame, setFrame] = useState(0)
	const [startedAt] = useState(Date.now())
	const [, setTick] = useState(0)

	useEffect(() => {
		const timer = setInterval(() => {
			setFrame((f) => (f + 1) % FRAMES.length)
			setTick((t) => t + 1)
		}, 80)
		return () => clearInterval(timer)
	}, [])

	const seconds = Math.floor((Date.now() - startedAt) / 1000)
	return (
		<Text color={COLORS.thinking}>
			{FRAMES[frame]} {label}
			<Text color={COLORS.dim}> ({seconds}s · esc to interrupt)</Text>
		</Text>
	)
}
