import React from "react";

import { Box } from "../primitives.js";

/**
 * Clips transcript overflow while keeping the live edge aligned from the
 * renderer's real layout. This avoids relying on approximate wrapped heights
 * to keep the final response line above the composer.
 */
export function TranscriptViewport({
  anchorToBottom,
  children,
}: React.PropsWithChildren<{ anchorToBottom: boolean }>) {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      overflow="hidden"
      justifyContent={anchorToBottom ? "flex-end" : "flex-start"}
    >
      {children}
    </Box>
  );
}
