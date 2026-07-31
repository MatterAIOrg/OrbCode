import React, { useState } from "react";

import { COLORS } from "../../branding.js";
import { Box } from "../primitives.js";

interface PaneResizeHandleProps {
  active?: boolean;
  onDragStart: (x: number) => void;
  onResize: (delta: number) => void;
  onReset: () => void;
}

/**
 * One-column pane separator. Drag horizontally for continuous resizing,
 * scroll for two-column nudges, or right-click to restore responsive sizing.
 */
export function PaneResizeHandle({
  active = false,
  onDragStart,
  onResize,
  onReset,
}: PaneResizeHandleProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <Box
      width={1}
      height="100%"
      flexShrink={0}
      backgroundColor={
        active || hovered ? COLORS.accent : "$orbcode.panelRaised"
      }
      shouldFill
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
        if (event.button === 2) {
          onReset();
          return;
        }
        if (event.button !== 0) return;
        onDragStart(event.x);
      }}
      onMouseScroll={(event) => {
        if (!event.scroll) return;
        const direction = event.scroll.direction;
        if (direction !== "up" && direction !== "down") return;
        onResize(direction === "up" ? 2 : -2);
        event.stopPropagation();
        event.preventDefault();
      }}
    />
  );
}
