import assert from "node:assert/strict";
import test from "node:test";

import {
  getClientMetadataHeaders,
  getShellName,
  X_CLIENT_USER_AGENT,
  X_DEVICE_OS,
  X_MODEL_CONTEXT_WINDOW,
} from "../src/api/headers.js";

test("reduces shell paths to a non-identifying executable name", () => {
  assert.equal(getShellName("/Users/alice/.cargo/bin/nu"), "nu");
  assert.equal(
    getShellName(String.raw`C:\Users\alice\tools\pwsh.exe`),
    "pwsh.exe",
  );
  assert.equal(
    getShellName("/home/alice/bin/fish\r\nInjected: value"),
    "fishInjected: value",
  );
});

test("reports CLI metadata independently of the HTTP tool user agent", () => {
  const headers = getClientMetadataHeaders(400_000);

  assert.equal(headers[X_MODEL_CONTEXT_WINDOW], "400000");
  assert.equal(headers[X_DEVICE_OS], process.platform);
  assert.match(headers[X_CLIENT_USER_AGENT], /^orbcode-cli\/\d+\.\d+\.\d+/);
});
