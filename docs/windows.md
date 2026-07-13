# Windows Source Checkout

mycli supports native Windows execution for both the Python CLI and Node TUI. Git Bash is optional.

## Requirements

- Python 3.13
- Node.js 22.19 or newer
- `uv`
- Git for source control; Git Bash is not required

## Shell Selection

On Windows, mycli detects the active command runtime in this order:

1. PowerShell 7 (`pwsh.exe`)
2. Windows PowerShell 5.1 (`powershell.exe`)
3. Command Prompt (`cmd.exe`)

The model sees one cross-platform `Shell` tool plus `ShellOutput` and `KillShell`. It does not receive separate Bash, PowerShell, or CMD tool schemas.

A recognized explicit `shell_path` can select Bash, zsh, sh, PowerShell, or CMD:

```toml
shell_path = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
```

You can also set a temporary override:

```powershell
$env:MYCLI_SHELL_PATH = "C:\Program Files\PowerShell\7\pwsh.exe"
uv run mycli
```

Invalid paths and unknown executables are ignored. mycli continues with automatic detection, and `mycli doctor` reports the ignored override and selected fallback.

CMD is a supported final fallback. Its command parser and approval policy are intentionally conservative: unknown syntax, expansion, redirection, pipes, and chained commands may require confirmation. PowerShell provides richer command semantics when available.

## Verification

Run the native shell smoke tests from PowerShell:

```powershell
uv run pytest tests/integration/test_cross_platform_shell.py -q
```

CI forces separate PowerShell 7, Windows PowerShell 5.1, and `cmd.exe` lanes so the CMD fallback remains tested even when PowerShell is installed.
