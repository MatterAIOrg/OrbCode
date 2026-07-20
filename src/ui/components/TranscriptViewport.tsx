import React from "react";

import { Box } from "../primitives.js";

export function getTranscriptPlacement({
  contentHeight,
  introHeaderOnly,
  introTopMargin,
  scrollOffset,
  transcriptHeight,
}: {
  contentHeight: number;
  introHeaderOnly: boolean;
  introTopMargin: number;
  scrollOffset: number;
  transcriptHeight: number;
}): { anchorToBottom: boolean; marginTop: number } {
  if (introHeaderOnly || transcriptHeight + introTopMargin <= contentHeight) {
    return { anchorToBottom: false, marginTop: introTopMargin };
  }

  // Under tight terminal heights, drop the decorative intro offset before
  // treating the transcript as scrollable.
  if (transcriptHeight <= contentHeight) {
    return { anchorToBottom: false, marginTop: 0 };
  }

  if (scrollOffset === 0) {
    return { anchorToBottom: true, marginTop: 0 };
  }

  const maxScrollOffset = transcriptHeight - contentHeight;
  return {
    anchorToBottom: false,
    marginTop: -(maxScrollOffset - Math.min(scrollOffset, maxScrollOffset)),
  };
}

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
