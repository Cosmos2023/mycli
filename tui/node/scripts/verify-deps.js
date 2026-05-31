#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const nodeRoot = process.env.MYCLI_NODE_TUI_ROOT ?? fileURLToPath(new URL("..", import.meta.url));

const markerConfig = readMarkerConfig(nodeRoot);
const requiredPaths = markerConfig.required_paths;

const missing = requiredPaths.filter((path) => !existsSync(join(nodeRoot, path)));

if (missing.length > 0) {
  const nodeModulesPath = join(nodeRoot, "node_modules");
  const state = existsSync(nodeModulesPath) ? "incomplete" : "missing";
  console.error(`Node TUI dependencies are ${state}.`);
  console.error("");
  console.error("Missing:");
  for (const path of missing) {
    console.error(`  - tui/node/${path}`);
  }
  console.error("");
  console.error(`Run: ${markerConfig.install_command}`);
  if (state === "incomplete") {
    console.error(
      `If a previous install was interrupted, run '${markerConfig.cleanup_command}' first and retry.`,
    );
  }
  process.exit(1);
}

function readMarkerConfig(root) {
  const configPath = join(root, "dependency-markers.json");
  try {
    const payload = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!Array.isArray(payload.required_paths) || payload.required_paths.length === 0) {
      throw new Error("required_paths must be a non-empty array");
    }
    return {
      required_paths: payload.required_paths.map((path) => String(path)),
      install_command: String(payload.install_command ?? "npm --prefix tui/node ci"),
      cleanup_command: String(payload.cleanup_command ?? "rm -rf tui/node/node_modules"),
    };
  } catch (error) {
    console.error(`Node TUI dependency marker config is invalid: ${error.message}`);
    process.exit(1);
  }
}
