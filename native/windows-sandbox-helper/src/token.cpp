#include "token.hpp"

#include <windows.h>
#include <aclapi.h>

#include <optional>
#include <stdexcept>
#include <utility>
#include <vector>

#include "sid.hpp"

namespace mycli::sandbox {
namespace {

std::optional<std::vector<unsigned char>> TryCopyLogonSid(HANDLE token) {
    DWORD bytes = 0;
    GetTokenInformation(token, TokenGroups, nullptr, 0, &bytes);
    if (bytes == 0) return std::nullopt;
    std::vector<unsigned char> storage(bytes);
    if (GetTokenInformation(
            token, TokenGroups, storage.data(), bytes, &bytes) == 0) {
        return std::nullopt;
    }
    const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(storage.data());
    for (DWORD index = 0; index < groups->GroupCount; ++index) {
        const auto& group = groups->Groups[index];
        if ((group.Attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID) continue;
        const DWORD sid_bytes = GetLengthSid(group.Sid);
        if (sid_bytes == 0) return std::nullopt;
        std::vector<unsigned char> sid(sid_bytes);
        if (CopySid(sid_bytes, sid.data(), group.Sid) == 0) return std::nullopt;
        return sid;
    }
    return std::nullopt;
}

std::vector<unsigned char> CopyLogonSid(HANDLE token) {
    if (auto sid = TryCopyLogonSid(token)) return std::move(*sid);

    TOKEN_LINKED_TOKEN linked{};
    DWORD bytes = 0;
    if (GetTokenInformation(
            token,
            TokenLinkedToken,
            &linked,
            sizeof(linked),
            &bytes) != 0 &&
        linked.LinkedToken != nullptr) {
        const UniqueHandle linked_token{linked.LinkedToken};
        if (auto sid = TryCopyLogonSid(linked_token.get())) return std::move(*sid);
    }
    throw std::runtime_error("restricted token base has no logon SID");
}

EXPLICIT_ACCESSW FullControlEntry(PSID sid) {
    EXPLICIT_ACCESSW entry{};
    entry.grfAccessPermissions = GENERIC_ALL;
    entry.grfAccessMode = GRANT_ACCESS;
    entry.grfInheritance = NO_INHERITANCE;
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    entry.Trustee.ptstrName = static_cast<LPWSTR>(sid);
    return entry;
}

void SetDefaultDacl(HANDLE token, const std::vector<PSID>& sids) {
    std::vector<EXPLICIT_ACCESSW> entries;
    entries.reserve(sids.size());
    for (const auto sid : sids) entries.push_back(FullControlEntry(sid));
    PACL acl = nullptr;
    const DWORD status = SetEntriesInAclW(
        static_cast<ULONG>(entries.size()), entries.data(), nullptr, &acl);
    if (status != ERROR_SUCCESS) {
        SetLastError(status);
        throw Win32Error("SetEntriesInAclW(token default DACL)");
    }
    TOKEN_DEFAULT_DACL default_dacl{acl};
    const BOOL updated = SetTokenInformation(
        token,
        TokenDefaultDacl,
        &default_dacl,
        sizeof(default_dacl));
    LocalFree(acl);
    if (updated == 0) throw Win32Error("SetTokenInformation(TokenDefaultDacl)");
}

void EnableChangeNotifyPrivilege(HANDLE token) {
    LUID luid{};
    if (LookupPrivilegeValueW(nullptr, SE_CHANGE_NOTIFY_NAME, &luid) == 0) {
        throw Win32Error("LookupPrivilegeValueW(SeChangeNotifyPrivilege)");
    }
    TOKEN_PRIVILEGES privileges{};
    privileges.PrivilegeCount = 1;
    privileges.Privileges[0].Luid = luid;
    privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    SetLastError(ERROR_SUCCESS);
    if (AdjustTokenPrivileges(
            token, FALSE, &privileges, 0, nullptr, nullptr) == 0) {
        throw Win32Error("AdjustTokenPrivileges(SeChangeNotifyPrivilege)");
    }
    if (GetLastError() == ERROR_NOT_ALL_ASSIGNED) {
        throw std::runtime_error("SeChangeNotifyPrivilege is unavailable on restricted token");
    }
}

}  // namespace

std::vector<unsigned char> CopyTokenLogonSid(HANDLE token) {
    return CopyLogonSid(token);
}

UniqueHandle CreateRestrictedPrimaryToken(const std::vector<PSID>& restricting_sids) {
    HANDLE raw_process_token = nullptr;
    constexpr DWORD kTokenAccess =
        TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY |
        TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID | TOKEN_ADJUST_PRIVILEGES;
    if (OpenProcessToken(GetCurrentProcess(), kTokenAccess, &raw_process_token) == 0) {
        throw Win32Error("OpenProcessToken");
    }
    const UniqueHandle process_token{raw_process_token};

    return CreateRestrictedPrimaryTokenFrom(process_token.get(), restricting_sids);
}

UniqueHandle CreateRestrictedPrimaryTokenFrom(
    HANDLE base_token,
    const std::vector<PSID>& restricting_sids) {
    if (restricting_sids.empty()) {
        throw std::invalid_argument("restricted token requires at least one restricting SID");
    }
    auto logon_sid = CopyLogonSid(base_token);
    auto everyone_sid = SidFromString(L"S-1-1-0");
    HANDLE raw_restricted_token = nullptr;
    std::vector<SID_AND_ATTRIBUTES> entries;
    entries.reserve(restricting_sids.size() + 2);
    for (const auto sid : restricting_sids) {
        entries.push_back(SID_AND_ATTRIBUTES{sid, 0});
    }
    entries.push_back(SID_AND_ATTRIBUTES{logon_sid.data(), 0});
    entries.push_back(SID_AND_ATTRIBUTES{everyone_sid.get(), 0});
    constexpr DWORD flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
    if (CreateRestrictedToken(
            base_token,
            flags,
            0,
            nullptr,
            0,
            nullptr,
            static_cast<DWORD>(entries.size()),
            entries.data(),
            &raw_restricted_token) == 0) {
        throw Win32Error("CreateRestrictedToken");
    }
    UniqueHandle token{raw_restricted_token};
    std::vector<PSID> default_dacl_sids{
        logon_sid.data(), everyone_sid.get()};
    default_dacl_sids.insert(
        default_dacl_sids.end(), restricting_sids.begin(), restricting_sids.end());
    SetDefaultDacl(token.get(), default_dacl_sids);
    EnableChangeNotifyPrivilege(token.get());
    return token;
}

}  // namespace mycli::sandbox
