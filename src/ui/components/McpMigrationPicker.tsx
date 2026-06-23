import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { COLORS } from "../../branding.js";
import { describeEntry, type MigrationEntry } from "../../commands/migrate.js";

const VISIBLE_ROWS = 10;

interface McpMigrationPickerProps {
  entries: MigrationEntry[];
  /** Called with the subset the user confirmed. */
  onConfirm: (selected: MigrationEntry[]) => void;
  /** User cancelled (esc). */
  onCancel: () => void;
}

/**
 * Combined checklist of all detected MCP servers across Claude Code (user),
 * Claude Code (this project), and Claude Desktop. Each row shows the source
 * as a dim label. Space toggles, enter confirms, esc cancels.
 *
 * Default state: every entry pre-checked, matching the CLI's `--all` flag.
 * The user unchecks the ones they don't want; the confirmation runs the
 * real `applyMigration` and reports the skipped count from conflicts.
 */
export function McpMigrationPicker({
  entries,
  onConfirm,
  onCancel,
}: McpMigrationPickerProps) {
  const [selected, setSelected] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(entries.map((e) => e.key)),
  );

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setSelected((s) => (s - 1 + entries.length) % entries.length);
      return;
    }
    if (key.downArrow || key.tab) {
      setSelected((s) => (s + 1) % entries.length);
      return;
    }
    if (key.return) {
      const picked: MigrationEntry[] = [];
      for (const entry of entries) {
        if (checked.has(entry.key)) picked.push(entry);
      }
      onConfirm(picked);
      return;
    }
    if (input === " ") {
      const entry = entries[selected];
      if (!entry) return;
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(entry.key)) next.delete(entry.key);
        else next.add(entry.key);
        return next;
      });
    }
  });

  if (entries.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={COLORS.primary}
        paddingX={1}
      >
        <Text bold color={COLORS.primary}>
          Migrate MCP servers
        </Text>
        <Text dimColor>No MCP servers found on this machine to migrate.</Text>
        <Text dimColor>
          Install Claude Code or Claude Desktop, or add servers with `orbcode
          mcp add`.
        </Text>
        <Text dimColor>esc to close</Text>
      </Box>
    );
  }

  const count = entries.length;
  const windowStart = Math.max(
    0,
    Math.min(selected - VISIBLE_ROWS + 1, count - VISIBLE_ROWS),
  );
  const visible = entries.slice(windowStart, windowStart + VISIBLE_ROWS);
  const checkedCount = entries.reduce(
    (n, e) => (checked.has(e.key) ? n + 1 : n),
    0,
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.primary}
      paddingX={1}
    >
      <Text bold color={COLORS.primary}>
        Migrate MCP servers from Claude Code / Desktop
      </Text>
      <Text dimColor>
        Servers will be copied to ~/.orbcode/settings.json. Conflicts (same name
        already exists) are skipped.
      </Text>
      {windowStart > 0 && <Text dimColor> ↑ {windowStart} more</Text>}
      {visible.map((entry, i) => {
        const isSelected = windowStart + i === selected;
        return (
          <Box key={entry.key} flexDirection="column">
            <Text color={isSelected ? COLORS.accent : undefined}>
              {isSelected ? "❯ " : "  "}
              {checked.has(entry.key) ? "☑" : "☐"} {entry.name}
              <Text dimColor> · {describeEntry(entry)}</Text>
            </Text>
            <Box paddingLeft={5}>
              <Text dimColor>{entry.sourceLabel}</Text>
            </Box>
          </Box>
        );
      })}
      {windowStart + VISIBLE_ROWS < count && (
        <Text dimColor> ↓ {count - windowStart - VISIBLE_ROWS} more</Text>
      )}
      <Text dimColor>
        space toggle · enter confirm ({checkedCount}/{count}) · esc cancel
      </Text>
    </Box>
  );
}
