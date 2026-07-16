import React from "react"

import { Box, type BoxProps } from "../primitives.js"
import { useTheme } from "../theme.js"

/** Native OpenTUI panel: its background is painted for every cell it owns. */
export function PopoverBox({ children, ...props }: React.PropsWithChildren<BoxProps>) {
	const theme = useTheme()
	return (
		<Box
			{...props}
			width={props.width ?? "100%"}
			backgroundColor={props.backgroundColor ?? theme.panel}
			shouldFill
		>
			{children}
		</Box>
	)
}
