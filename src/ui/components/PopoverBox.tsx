import React, { useLayoutEffect, useRef, useState } from "react"
import { Box, measureElement, Text, type BoxProps, type DOMElement } from "ink"

/** A bordered Ink box with an opaque fill restricted to its interior cells. */
export function PopoverBox({ children, ...props }: React.PropsWithChildren<BoxProps>) {
	const ref = useRef<DOMElement>(null)
	const [size, setSize] = useState({ width: 0, height: 0 })

	useLayoutEffect(() => {
		if (!ref.current) return
		const measured = measureElement(ref.current)
		setSize((current) =>
			current.width === measured.width && current.height === measured.height ? current : measured,
		)
	})

	const interiorWidth = Math.max(0, size.width - 2)
	const interiorHeight = Math.max(0, size.height - 2)
	const edge = " ".repeat(size.width)
	const fill = " ".repeat(interiorWidth)

	return (
		<Box ref={ref} position="relative" width={props.width ?? "100%"} flexDirection="column">
			{size.width > 1 && size.height > 1 && (
				<Box position="absolute" width={size.width} height={size.height} flexDirection="column" overflow="hidden">
					<Text>{edge}</Text>
					{Array.from({ length: interiorHeight }, (_, index) => (
						<Text key={index}>
							{" "}
							<Text backgroundColor="#242424">{fill}</Text>
							{" "}
						</Text>
					))}
					<Text>{edge}</Text>
				</Box>
			)}
			<Box {...props}>{children}</Box>
		</Box>
	)
}
