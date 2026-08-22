# Windows Source Checkout

mycli runs natively on Windows through Node.js. Git Bash and a separate language runtime are not
required by the installed npm CLI.

## Requirements

- Node.js 22.19 or newer; Node 24 is supported.
- npm and Git.
- Visual Studio Build Tools only when npm must compile a native dependency instead of using a
  prebuilt binary.

Install and run from PowerShell:

```powershell
npm ci
npm run build
npm run mycli
```

## Shell Selection

mycli detects the command runtime in this order:

1. PowerShell 7 (`pwsh.exe`)
2. Windows PowerShell 5.1 (`powershell.exe`)
3. Command Prompt (`cmd.exe`)

The model sees one cross-platform `Shell` contract plus the relevant input/output control tools.
It does not receive separate Bash, PowerShell, and CMD schemas.

Configure an explicit shell in `~/.mycli/config.toml`:

```toml
[shell]
path = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
```

Or set a temporary override:

```powershell
$env:MYCLI_SHELL_PATH = "C:\Program Files\PowerShell\7\pwsh.exe"
npm run mycli
```

Invalid paths and unknown executables are ignored, automatic detection continues, and
`mycli doctor` reports the selected shell without exposing command or environment values.

CMD is the final supported fallback. Its approval parser is intentionally conservative: expansion,
redirection, pipes, chained commands, or unknown syntax may require confirmation.

## PTY And Sandbox

Interactive shell sessions use `node-pty` and ConPTY. Restricted process profiles use the packaged
`backend/packages/tools/native/windows/mycli-windows-sandbox.exe` helper built from
`native/windows-sandbox-helper`. A missing or invalid helper returns `sandbox_unavailable`; mycli
does not run the command unrestricted.

## Verification

```powershell
npm run contracts:check
npm test
npm run typecheck
npm run smoke:m8
npm run smoke:package
```

CI covers Node 22.19 and Node 24 on Windows and separately compiles/tests the sandbox protocol,
restricted-token primitives, filesystem policy, and network policy.
