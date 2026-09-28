# Installation

mycli is distributed as `@cosmos2023/mycli` on npm; the command is `mycli`. Install Node.js
22.19.0 or newer (Node 24 is supported), including npm, before installing mycli.

## Install with visible progress

Download `scripts/install.mjs` from the repository as described in the
[README](../README.md#installer-with-progress), then run `node mycli-install.mjs`. A source checkout
can run `node scripts/install.mjs` without `npm ci` or a build. The file is self-contained and uses
only Node.js built-ins.

The installer reports three stages:

```text
mycli installer

[1/3] Checking environment and install directory OK (0s)
  Install directory: /home/you/.local
[2/3] Downloading and installing OK (12s)
[3/3] Verifying installed command OK (1s)

Installed mycli 0.1.1
Command: /home/you/.local/bin/mycli

Next:
  mycli setup
  mycli
```

The elapsed time and activity indicator remain visible while npm downloads dependencies and builds
native modules. They indicate activity, not a percentage or estimated completion time. Output is
plain when redirected, in a dumb terminal, or with `--plain`; it includes a periodic elapsed-time
line for long operations. `NO_COLOR` disables color. `--verbose` streams npm and native build output
instead of animating the progress line.

| Option | Behavior |
| --- | --- |
| `--version latest` | Install the latest stable published release; the default |
| `--version next` | Install the published prerelease tag, if available |
| `--version 0.1.1` | Install a specific release |
| `--prefix <directory>` | Override the installation directory |
| `--cache <directory>` | Override the separate npm cache and installer-log location |
| `--dry-run` | Show the plan without downloading, installing, or creating directories |
| `--verbose` | Show dependency activity while it happens |
| `--plain` | Disable animation and color |
| `--help` | Show usage |

Rerun the installer to update. The installer always uses the official npm registry and keeps optional
dependencies enabled. It uses npm's normal installation behavior; it does not provide transactional
rollback of a failed or interrupted upgrade. Retry the installer, or select a prior version explicitly.

## Directories and PATH

| Platform | Install prefix | Command directory | Default cache |
| --- | --- | --- | --- |
| macOS / Linux | `~/.local` | `~/.local/bin` | `$XDG_CACHE_HOME/mycli/npm`, or `~/.cache/mycli/npm` |
| Windows | `%LOCALAPPDATA%\mycli` | `%LOCALAPPDATA%\mycli` | `%LOCALAPPDATA%\mycli\cache\npm` |

Installation needs no sudo. The separate cache avoids root-owned files left behind in `~/.npm` by
previous sudo installs. Custom directory choices must be writable by the current user.

The installer verifies the newly installed entry directly, then checks which `mycli` executable PATH
selects. If another copy takes precedence, it reports that path and prints the command to prepend the
new directory. It does not edit shell profiles, Windows user PATH, npm configuration, or existing
unrelated launchers. Shell aliases and functions can also override executable lookup; use `type -a mycli`
on Bash/Zsh or `Get-Command mycli -All` in PowerShell to inspect those.

After adjusting PATH, `mycli --version` should match the installed release. Some shells cache command
locations; start a new terminal, or use `rehash` in Zsh / `hash -r` in Bash. Then run `mycli setup` to
configure a provider and `mycli` to start. Installation does not change credentials, configuration,
or sessions in `~/.mycli`.

## Troubleshooting

- **Quiet npm install:** use the installer, or add `--progress --loglevel=info` to direct npm
  installation. Add `--foreground-scripts` to see native dependency build output.
- **`E404`:** check the package name (`@cosmos2023/mycli`, including the `m`) and requested version.
- **Existing command / `EEXIST`:** the installer stops if its command path belongs to another
  launcher. Inspect and move the old launcher aside yourself, or choose another `--prefix`. It never
  uses `--force` to overwrite an unrelated command. A stale system-wide link outside the selected
  user prefix does not block installation there.
- **`EACCES` / `EPERM`:** choose a user-owned `--prefix` and `--cache`. There is no need to modify
  system directories or use sudo for the defaults.
- **Download or build failure:** the installer exits unsuccessfully, shows recent npm output, and
  saves a bounded, private log in the selected cache. Retry with `--verbose` to see activity live.
  Node native dependencies may need [node-gyp prerequisites](https://github.com/nodejs/node-gyp#installation)
  when a suitable prebuilt binary is unavailable.
- **Cancelled installation:** Ctrl+C exits with code 130 and stops dependency build processes.
  A partial installation can remain; rerun the same command to retry.

The npm command remains supported independently:

```bash
npm install -g @cosmos2023/mycli@latest
```

Its installation prefix and cache follow your npm configuration. The standalone installer explicitly
selects the user directories above instead.
