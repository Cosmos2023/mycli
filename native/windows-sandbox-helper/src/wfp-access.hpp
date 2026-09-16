#pragma once
#include <windows.h>

namespace mycli::sandbox {

void GrantWfpProxyAccess(HANDLE engine, const GUID& provider, const GUID& sublayer, PSID owner);
bool HasWfpProxyAccess(HANDLE engine, const GUID& provider, const GUID& sublayer, PSID owner);

}  // namespace mycli::sandbox
