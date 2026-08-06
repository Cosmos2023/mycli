# Windows sandbox helper

Release builds place `mycli-windows-sandbox.exe` in this directory. The Node
runtime resolves the helper from the packaged `@mycli/tools` assets and
validates its protocol handshake before restricted commands can run.
