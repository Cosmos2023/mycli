# Verification

Verified on 2026-09-10 with Node 24.14.1 on macOS. All implementation tasks are
complete. The repository-wide run is not fully green because two previously
recorded M7 extension regressions still fail; no tests were disabled in source.

## Passed Checks

| Check | Result |
| --- | --- |
| Production workspace build (`npm test` pretest) | Passed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run contracts:check` | Passed |
| `npm run config:check` | Passed |
| `git diff --check` | Passed |
| Error emitter inventory | 811 grouped classifications match the fixture |
| Focused fault and compatibility tests | 328 passed |
| Unit and contract suites | 3,916 passed |
| Integration, platform and release suites, excluding the two M7 cases below | 334 passed |

The combined repository verification covers 4,250 passing tests. Additional
targeted runs verified the current database format, all root/child execution
topologies, image-capability configuration and catalog combinations, and live,
persisted and resumed provider failures. These overlap the repository suites.

Fault coverage includes retry cancellation, Worker loss, malformed optional
contexts, legacy negotiation, burst output, storage commit failpoints, SQLite
lock/capacity evidence, and delivery failure after a successful terminal commit.
The last case retains the committed occurrence and cannot replay the request.
Provider routing keeps the original captured configuration identity when image
capability calculations derive a separate execution configuration.

## Existing M7 Failures

- `backend/apps/mycli/test/m7-extensions.integration.test.ts:156`:
  `M7 live smoke emits only structural extension and cleanup state` returns
  status `failed`, `persisted=false`, and exit code 1 instead of completion.
- `backend/apps/mycli/test/m7-extensions.integration.test.ts:535`:
  `M7 runs skills MCP hooks plugins and a subagent entirely in Node` retains
  the previously recorded missing `wait_agent` completion failure. Its isolated
  rerun reports failure and then stalls during cleanup; the owned process was
  interrupted. This test file is unchanged by the error-system work.

`npm test -- --test-reporter=spec` was run without exclusions. After isolating
the M7 failures, the remaining suites passed using:

```sh
node scripts/run-test-suite.mjs --suite integration --suite platform --suite release --test-reporter=spec --test-skip-pattern='^(M7 live smoke emits only structural extension and cleanup state|M7 runs skills MCP hooks plugins and a subagent entirely in Node)$'
```

Logs are in `/tmp/mycli-error-system-npm-test.log`,
`/tmp/mycli-error-system-remaining-suites.log`,
`/tmp/mycli-error-system-m7-baseline.log`, and
`/tmp/mycli-error-system-m7-extensions-baseline.log`. All owned test sessions were
closed, and the final process check found no remaining test runners or M7
fixture processes. Database tests used temporary fixtures, not user databases.
