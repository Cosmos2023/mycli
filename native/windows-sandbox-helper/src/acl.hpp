#pragma once
#include <windows.h>
#include <filesystem>
namespace mycli::sandbox {
void GrantWritableRoot(const std::filesystem::path& root, PSID capability_sid);
}
