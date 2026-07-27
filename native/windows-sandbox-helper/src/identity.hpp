#pragma once

#include <string>
#include <filesystem>

#include "sid.hpp"
#include "win32.hpp"

namespace mycli::sandbox {

inline constexpr wchar_t kOfflineUsername[] = L"mycli_sandbox_offline";

struct OfflineIdentity {
    UniqueHandle token;
    LocalSid sid;
    std::wstring sid_string;
};

void SetupOfflineIdentity();
OfflineIdentity LoadOfflineIdentity();
bool OfflineIdentityCredentialsExist();
std::filesystem::path SandboxStateDirectory();

}  // namespace mycli::sandbox
