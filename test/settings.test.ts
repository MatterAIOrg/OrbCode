import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  loadSettings,
  saveSettings,
} from "../src/config/settings.js";

test("persists the selected interface mode across settings reloads", async () => {
  const configDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "orbcode-settings-"),
  );
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "orbcode-settings-workspace-"),
  );
  const previousConfigDir = process.env.MATTERAI_CONFIG_DIR;
  const previousCwd = process.cwd();

  try {
    process.env.MATTERAI_CONFIG_DIR = configDir;
    process.chdir(workspace);

    const defaults = loadSettings();
    assert.equal(defaults.interfaceMode, "cli");

    saveSettings({ ...defaults, interfaceMode: "editor" });
    assert.equal(loadSettings().interfaceMode, "editor");

    const persisted = JSON.parse(
      await fs.readFile(path.join(configDir, "config.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(persisted.interfaceMode, "editor");

    persisted.interfaceMode = "invalid";
    await fs.writeFile(
      path.join(configDir, "config.json"),
      `${JSON.stringify(persisted)}\n`,
    );
    assert.equal(loadSettings().interfaceMode, "cli");
  } finally {
    process.chdir(previousCwd);
    if (previousConfigDir === undefined) {
      delete process.env.MATTERAI_CONFIG_DIR;
    } else {
      process.env.MATTERAI_CONFIG_DIR = previousConfigDir;
    }
    await Promise.all([
      fs.rm(configDir, { recursive: true, force: true }),
      fs.rm(workspace, { recursive: true, force: true }),
    ]);
  }
});
