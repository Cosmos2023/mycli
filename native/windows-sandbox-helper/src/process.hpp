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
DWORD RunHostProcessInJob(
    const std::vector<std::wstring>& argv,
    const std::filesystem::path& cwd);
DWORD RunPsecProcessInJob(
    HANDLE security_environment,
    const std::vector<std::wstring>& argv,
    const std::filesystem::path& cwd);
DWORD RunProcessWithLogonInJob(
    const std::wstring& username,
    const std::wstring& password,
    const std::vector<std::wstring>& argv,
    const std::filesystem::path& cwd,
    const std::wstring& account_sid,
    unsigned short network_proxy_port);

}  // namespace mycli::sandbox
