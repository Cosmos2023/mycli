#pragma once
#include <windows.h>
#include "protocol.hpp"
namespace mycli::sandbox {
DWORD RunSandboxRequest(const SandboxRequest& request);
}
