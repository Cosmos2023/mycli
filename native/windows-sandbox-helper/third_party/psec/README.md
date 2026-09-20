# Windows PSEC schema

`ProcessSecurityEnvironment.fbs` is vendored unchanged from Microsoft MXC revision
`6cd3d58f05d3447e67109cfb75e042803b843ca4`, `external/windows-sdk/` (MIT license).
The LF-normalized SHA-256 is
`7d14b01850a735329da00cde4d4d2e32e463f49026a39708be9059fd64e764d3`.
Its upstream provenance records validation against Windows build `10.0.26663.1000`.
Runtime capability and enforcement checks are required on every supported platform.

The CMake build pins FlatBuffers 25.12.19 by archive SHA-256 and generates C++ bindings
in the build directory. Do not edit generated bindings or change schema field order.
See `cmake/psec-schema.cmake` for the reproducible generation command.
