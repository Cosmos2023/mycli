#pragma once
#include <windows.h>
#include <filesystem>
namespace mycli::sandbox {
void GrantWritableRoot(const std::filesystem::path& root, PSID capability_sid);
void GrantReadableRoot(const std::filesystem::path& root, PSID account_sid);
void DenyReadPath(const std::filesystem::path& path, PSID capability_sid);
void DenyWritePath(const std::filesystem::path& path, PSID capability_sid);
}
