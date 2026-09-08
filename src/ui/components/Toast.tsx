import React from "react";
import { Box, Text } from "../primitives.js";
import { COLORS } from "../../branding.js";
import { useTheme } from "../theme.js";

export interface ToastProps {
  message: string;
}

export function Toast({ message }: ToastProps) {
  const theme = useTheme();
  const successColor = theme.success ?? COLORS.success;

  return (
    <Box
      borderStyle="round"
      borderColor={successColor}
      backgroundColor={theme.panel}
      paddingX={1}
    >
      <Text color={successColor} bold selectable={false}>
        {message}
      </Text>
    </Box>
  );
}
