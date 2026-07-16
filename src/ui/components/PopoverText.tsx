import React from "react"
import { Text as InkText } from "ink"

/** Text that preserves the opaque background painted by PopoverBox. */
export function PopoverText(props: React.ComponentProps<typeof InkText>) {
	return <InkText {...props} backgroundColor="#242424" />
}
