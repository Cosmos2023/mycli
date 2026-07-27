#pragma once

#include <windows.h>

#include <filesystem>
#include <string>
#include <vector>

namespace mycli::sandbox {

std::wstring QuoteWindowsArgument(const std::wstring& argument);
std::wstring BuildWindowsCommandLine(const std::vector<std::wstring>& argv);
DWORD RunProcessInJob(
    HANDLE primary_token,
    const std::vector<std::wstring>& argv,
    const std::filesystem::path& cwd);

}  // namespace mycli::sandbox

