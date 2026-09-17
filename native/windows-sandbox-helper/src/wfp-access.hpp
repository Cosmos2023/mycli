#pragma once
#include <windows.h>
#include <filesystem>

namespace mycli::sandbox {

void GrantWfpProxyAccess(HANDLE engine, const GUID& provider, const GUID& sublayer, PSID owner, const std::filesystem::path& state_directory);
void RestoreWfpProxyAccess(HANDLE engine, const GUID& provider, PSID owner, const std::filesystem::path& state_directory);
bool HasWfpProxyAccess(HANDLE engine, const GUID& provider, const GUID& sublayer, PSID owner);

}  // namespace mycli::sandbox
