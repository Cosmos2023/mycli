# Windows Source Checkout

mycli 支持在原生 Windows 上从源码运行。Python CLI 和 Node TUI 可以从 PowerShell 启动，但 agent 的 shell 命令统一交给 Git for Windows Bash 执行。

## Prerequisites

- Python 3.13
- uv
- Node.js 22.19 或更新版本
- npm
- Git for Windows，并包含 Git Bash

安装依赖并启动：

```powershell
uv sync --dev
npm ci --prefix tui/mycli-shell
uv run mycli
```

## Bash Resolution

mycli 按以下顺序寻找 Bash：

1. `MYCLI_SHELL_PATH` 环境变量或配置文件中的 `shell_path`；环境变量优先。
2. `%ProgramFiles%\Git\bin\bash.exe`。
3. `%ProgramFiles(x86)%\Git\bin\bash.exe`。
4. Windows `PATH` 中的 `bash.exe`。

用户配置 `~/.mycli/config.toml` 示例：

```toml
shell_path = "C:\\Program Files\\Git\\bin\\bash.exe"
```

临时使用 PowerShell 环境变量覆盖：

```powershell
$env:MYCLI_SHELL_PATH = "C:\Program Files\Git\bin\bash.exe"
uv run mycli
```

如果提示找不到 Bash，先确认 `C:\Program Files\Git\bin\bash.exe` 存在；若 Git 安装在其他目录，设置 `MYCLI_SHELL_PATH` 或 `shell_path`。也可以把 Git 的 `bin` 目录加入 Windows `PATH` 后重新打开终端。

第一版 Windows shell 契约只支持 Git Bash 语义。WSL、PowerShell 和 CMD 的命令语法不在支持范围内；不要向 agent 提供仅适用于这些 shell 的命令片段。
