import React, { useState } from "react";
import { Box, Text } from "../primitives.js";
import { useTheme } from "../theme.js";

export interface ScrollToBottomChipProps {
  scrollOffset: number;
  width?: number;
  onClick: () => void;
}

export function ScrollToBottomChip({
  scrollOffset,
  width = 80,
  onClick,
}: ScrollToBottomChipProps) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);

  const label =
    width < 35
      ? `↓ Bottom${scrollOffset > 1 ? ` (${scrollOffset})` : ""}`
      : `↓ Scroll to bottom${scrollOffset > 1 ? ` (${scrollOffset})` : ""}`;

  return (
    <Box
      borderStyle="round"
      borderColor={hovered ? theme.accent : theme.panelRaised}
      backgroundColor={hovered ? theme.panelRaised : theme.panel}
      paddingX={1}
      onMouseDown={(e) => {
        e.stopPropagation?.();
        onClick();
      }}
      onMouseMove={(e) => {
        e.stopPropagation?.();
        if (!hovered) setHovered(true);
      }}
    >
      <Text
        color={hovered ? theme.accent : theme.dim}
        bold={hovered}
        selectable={false}
        onMouseDown={(e) => {
          e.stopPropagation?.();
          onClick();
        }}
      >
        {label}
      </Text>
    </Box>
  );
}
