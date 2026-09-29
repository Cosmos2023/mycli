#!/usr/bin/env node

// The contracts program is large enough to sit at the compiler's default stack
// limit: generated validators and schema-derived unions push the checker deep
// enough that a runner whose effective stack is a little smaller aborts with
// "Maximum call stack size exceeded" while a developer machine still fits. Run
// the compiler in a child with an explicit budget so the build is not decided by
// how much stack the host happens to give the process.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const child = spawnSync(process.execPath, ["--stack-size=2048", tsc, ...process.argv.slice(2)], { stdio: "inherit" });
process.exitCode = child.status ?? 1;