#pragma once
#include <windows.h>
#include "protocol.hpp"
namespace mycli::sandbox {
void PrepareSandboxRequest(const SandboxRequest& request, PSID account_sid);
DWORD RunPreparedSandboxRequest(const SandboxRequest& request);
DWORD RunSandboxRequest(
    const SandboxRequest& request,
    HANDLE base_token = nullptr,
    PSID account_sid = nullptr);
}
