#pragma once
#include <filesystem>
#include <string>
namespace mycli::sandbox {
void QuiesceSandboxAccounts(const std::filesystem::path& directory, const std::wstring& owner_sid);
void UninstallSandboxAccounts(const std::filesystem::path& directory, const std::wstring& owner_sid);
}
