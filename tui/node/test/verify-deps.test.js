import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptPath = fileURLToPath(new URL("../scripts/verify-deps.js", import.meta.url));
const requiredPaths = [
  "node_modules/.bin/tsx",
  "node_modules/.bin/tsc",
  "node_modules/ink",
  "node_modules/react",
  "node_modules/tsx",
  "node_modules/typescript",
];

function writeMarkerConfig(nodeRoot) {
  writeFileSync(
    join(nodeRoot, "dependency-markers.json"),
    JSON.stringify({
      required_paths: requiredPaths,
      install_command: "npm --prefix tui/node ci",
      cleanup_command: "rm -rf tui/node/node_modules",
    }),
  );
}

test("verify-deps reports actionable missing dependency markers", () => {
  const nodeRoot = mkdtempSync(join(tmpdir(), "mycli-node-tui-deps-"));
  writeMarkerConfig(nodeRoot);
  mkdirSync(join(nodeRoot, "node_modules", "es-toolkit"), { recursive: true });

  const result = spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, MYCLI_NODE_TUI_ROOT: nodeRoot },
    encoding: "utf-8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node TUI dependencies are incomplete/);
  assert.match(result.stderr, /tui\/node\/node_modules\/\.bin\/tsx/);
  assert.match(result.stderr, /npm --prefix tui\/node ci/);
  assert.match(result.stderr, /rm -rf tui\/node\/node_modules/);
});

test("verify-deps reports missing dependencies without cleanup advice for clean installs", () => {
  const nodeRoot = mkdtempSync(join(tmpdir(), "mycli-node-tui-deps-"));
  writeMarkerConfig(nodeRoot);

  const result = spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, MYCLI_NODE_TUI_ROOT: nodeRoot },
    encoding: "utf-8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node TUI dependencies are missing/);
  assert.match(result.stderr, /npm --prefix tui\/node ci/);
  assert.doesNotMatch(result.stderr, /rm -rf tui\/node\/node_modules/);
});

test("verify-deps exits cleanly when required markers exist", () => {
  const nodeRoot = mkdtempSync(join(tmpdir(), "mycli-node-tui-deps-"));
  writeMarkerConfig(nodeRoot);
  for (const path of requiredPaths) {
    if (path.includes("/.bin/")) {
      continue;
    }
    mkdirSync(join(nodeRoot, path), { recursive: true });
  }
  mkdirSync(join(nodeRoot, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(nodeRoot, "node_modules", ".bin", "tsx"), "");
  writeFileSync(join(nodeRoot, "node_modules", ".bin", "tsc"), "");

  const result = spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, MYCLI_NODE_TUI_ROOT: nodeRoot },
    encoding: "utf-8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});
