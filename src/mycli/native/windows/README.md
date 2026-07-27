# Windows sandbox helper

Release builds place `mycli-windows-sandbox.exe` in this directory. The Python
runtime only discovers the helper at this packaged location and validates its
protocol handshake before restricted commands can run.
