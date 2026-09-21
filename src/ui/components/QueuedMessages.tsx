import React, { useState } from "react";
import { Box, Text } from "../primitives.js";
import { COLORS } from "../../branding.js";
import type { SubmittedPrompt } from "../../attachments.js";

/** Messages shown before the queue collapses into a "… N more" line. */
const MAX_VISIBLE = 5;
const QUEUE_PREVIEW_LIMIT = 80;
const ACTION_TAG = "[send now]";

function fit(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return text.slice(0, Math.max(0, maxWidth));
  return text.slice(0, maxWidth - 1) + "…";
}

function previewText(message: SubmittedPrompt): string {
  const text = (message.text || "Attached files").replace(/\n/g, "↵");
  const truncated =
    text.length <= QUEUE_PREVIEW_LIMIT
      ? text
      : text.slice(0, QUEUE_PREVIEW_LIMIT - 1) + "…";
  return message.attachments.length > 0
    ? `${truncated} · 📎 ${message.attachments.length}`
    : truncated;
}

export interface QueuedMessagesProps {
  messages: SubmittedPrompt[];
  width: number;
  /** Force-send the message at `index` (0 = next in line) without waiting. */
  onForceSend: (index: number) => void;
}

/** Messages typed while the agent is streaming, each with an action to
 *  force-send it ahead of the in-flight turn. */
export function QueuedMessages({
  messages,
  width,
  onForceSend,
}: QueuedMessagesProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const header = fit(
    `Queue (${messages.length}) · ${width < 56 ? "ctrl+s" : "ctrl+s sends the next one now"}`,
    width,
  );
  const textWidth = Math.max(8, width - 6 - ACTION_TAG.length);

  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      <Text color={COLORS.dim} bold>
        {header}
      </Text>
      {messages.slice(0, MAX_VISIBLE).map((message, index) => {
        const isHovered = hovered === index;
        return (
          <Box key={index} flexDirection="row">
            <Text color={isHovered ? COLORS.accent : COLORS.dim}>
              {`${index + 1}. ${fit(previewText(message), textWidth)}`}
            </Text>
            <Text
              color={isHovered ? COLORS.accent : COLORS.primary}
              bold={isHovered}
              selectable={false}
              onMouseDown={(event) => {
                event.stopPropagation?.();
                onForceSend(index);
              }}
              onMouseMove={(event) => {
                event.stopPropagation?.();
                if (hovered !== index) setHovered(index);
              }}
            >
              {` ${ACTION_TAG}`}
            </Text>
          </Box>
        );
      })}
      {messages.length > MAX_VISIBLE && (
        <Text color={COLORS.dim}>
          {` … ${messages.length - MAX_VISIBLE} more`}
        </Text>
      )}
    </Box>
  );
}
