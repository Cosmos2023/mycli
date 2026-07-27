#pragma once

#include <string>
#include <filesystem>
#include <vector>

#include "sid.hpp"
#include "win32.hpp"

namespace mycli::sandbox {

struct OfflineIdentity {
    UniqueHandle token;
    LocalSid sid;
    std::wstring sid_string;
};

std::wstring CurrentUserSidString();
std::wstring OfflineUsernameForOwner(const std::wstring& owner_sid);
void SetupOfflineIdentity(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid);
OfflineIdentity LoadOfflineIdentity(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid);
DWORD RunAsOfflineIdentity(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid,
    const std::vector<std::wstring>& argv,
    const std::filesystem::path& cwd);
bool OfflineIdentityCredentialsExist(const std::filesystem::path& state_directory);
std::filesystem::path SandboxStateDirectory();

}  // namespace mycli::sandbox
