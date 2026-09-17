#pragma once

#include <string>
#include <filesystem>
#include <vector>

#include "sid.hpp"
#include "win32.hpp"

namespace mycli::sandbox {

enum class SandboxIdentityKind { kOffline, kOnline, kProxy };

struct SandboxIdentity {
    UniqueHandle token;
    LocalSid sid;
    std::wstring sid_string;
};

std::wstring CurrentUserSidString();
std::wstring TokenUserSidString(HANDLE token);
std::vector<std::wstring> OwnedSandboxAccountSids(const std::filesystem::path& state_directory, const std::wstring& owner_sid);
void DisableSandboxAccounts(const std::filesystem::path& state_directory, const std::wstring& owner_sid);
void DeleteSandboxAccounts(const std::filesystem::path& state_directory, const std::wstring& owner_sid);
bool SandboxAccountsExist(const std::wstring& owner_sid);
std::wstring SandboxUsernameForOwner(
    const std::wstring& owner_sid, SandboxIdentityKind kind);
void SetupSandboxIdentity(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid,
    SandboxIdentityKind kind);
void ResetSandboxIdentityCredentials(
    const std::filesystem::path& state_directory);
SandboxIdentity LoadSandboxIdentity(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid,
    SandboxIdentityKind kind);
DWORD RunAsSandboxIdentity(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid,
    SandboxIdentityKind kind,
    const std::vector<std::wstring>& argv,
    const std::filesystem::path& cwd,
    unsigned short network_proxy_port = 0);
bool SandboxIdentityCredentialsExist(
    const std::filesystem::path& state_directory, SandboxIdentityKind kind);
std::filesystem::path SandboxStateDirectory();

}  // namespace mycli::sandbox
