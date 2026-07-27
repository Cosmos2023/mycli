#pragma once
#include <windows.h>
#include "protocol.hpp"
namespace mycli::sandbox {
DWORD RunSandboxRequest(
    const SandboxRequest& request,
    HANDLE base_token = nullptr,
    PSID account_sid = nullptr);
}
