# Ripgrep Platform Packages

This directory owns the release-only npm packages that carry ripgrep for mycli. The child
directory name is the canonical `RIPGREP_TARGETS` key, while each child manifest declares the
public npm package name and compatible `os`/`cpu` pair.

These packages are intentionally outside the root npm workspaces. npm validates every workspace
against the build host, which would make a normal install fail on the five incompatible targets.
The package smoke and release staging scripts pack each child directory explicitly instead.

Do not add generated binaries to source control. `prepack` downloads and verifies the declared
target into `vendor/`; `postpack` removes that staging directory.
