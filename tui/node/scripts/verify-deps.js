#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const nodeRoot = process.env.MYCLI_NODE_TUI_ROOT ?? fileURLToPath(new URL("..", import.meta.url));

const requiredPaths = [
  "node_modules/.bin/tsx",
  "node_modules/.bin/tsc",
  "node_modules/ink",
  "node_modules/react",
  "node_modules/tsx",
  "node_modules/typescript",
];

const missing = requiredPaths.filter((path) => !existsSync(join(nodeRoot, path)));

if (missing.length > 0) {
  console.error("Node TUI dependencies are missing or incomplete.");
  console.error("");
  console.error("Missing:");
  for (const path of missing) {
    console.error(`  - tui/node/${path}`);
  }
  console.error("");
  console.error("Run: npm --prefix tui/node ci");
  console.error(
    "If a previous install was interrupted, remove tui/node/node_modules first and rerun the command.",
  );
  process.exit(1);
}
