#pragma once

#include <string>
#include <filesystem>
#include <vector>

#include "sid.hpp"
#include "win32.hpp"

namespace mycli::sandbox {

enum class SandboxIdentityKind { kOffline, kOnline };

struct SandboxIdentity {
    UniqueHandle token;
    LocalSid sid;
    std::wstring sid_string;
};

std::wstring CurrentUserSidString();
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
    const std::filesystem::path& cwd);
bool SandboxIdentityCredentialsExist(
    const std::filesystem::path& state_directory, SandboxIdentityKind kind);
std::filesystem::path SandboxStateDirectory();

}  // namespace mycli::sandbox
