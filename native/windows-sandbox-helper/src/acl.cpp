#include "acl.hpp"
#include "win32.hpp"
#include "path-guard.hpp"
#include "state.hpp"
#include <aclapi.h>

namespace mycli::sandbox {
namespace {
DWORD RemoveSandboxAces(PACL acl, PSID sid) {
    // REVOKE_ACCESS leaves deny ACEs behind. Remove our allow/deny entries while
    // preserving every unrelated ACE, including its order and inheritance flags.
    for (DWORD index = acl->AceCount; index > 0; --index) {
        void* raw = nullptr;
        if (GetAce(acl, index - 1, &raw) == 0) return GetLastError();
        const auto* header = static_cast<const ACE_HEADER*>(raw);
        PSID trustee = nullptr;
        if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
            trustee = &static_cast<ACCESS_ALLOWED_ACE*>(raw)->SidStart;
        } else if (header->AceType == ACCESS_DENIED_ACE_TYPE) {
            trustee = &static_cast<ACCESS_DENIED_ACE*>(raw)->SidStart;
        }
        if (trustee != nullptr && EqualSid(trustee, sid) != 0 && DeleteAce(acl, index - 1) == 0) {
            return GetLastError();
        }
    }
    return ERROR_SUCCESS;
}

bool HasPathAccess(const std::filesystem::path& path, PSID account_sid, DWORD permissions) {
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const PathGuard guard{path};
    const DWORD status = GetSecurityInfo(
        guard.leaf(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &acl, nullptr, &descriptor);
    if (status != ERROR_SUCCESS) {
        SetLastError(status);
        throw Win32Error("read ancestor directory security");
    }
    TRUSTEE_W trustee{};
    BuildTrusteeWithSidW(&trustee, account_sid);
    DWORD granted = 0;
    const DWORD access_status = acl == nullptr ? ERROR_SUCCESS
        : GetEffectiveRightsFromAclW(acl, &trustee, &granted);
    const bool allowed = acl == nullptr || (granted & permissions) == permissions;
    if (descriptor != nullptr) LocalFree(descriptor);
    if (access_status != ERROR_SUCCESS) {
        SetLastError(access_status);
        throw Win32Error("check ancestor directory access");
    }
    return allowed;
}

void UpdatePathAcl(
    const std::filesystem::path& root,
    PSID capability_sid,
    DWORD permissions,
    ACCESS_MODE mode,
    DWORD inheritance) {
    PACL old_acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const PathGuard guard{root, READ_CONTROL | WRITE_DAC};
    DWORD status = GetSecurityInfo(
        guard.leaf(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &old_acl, nullptr, &descriptor);
    if (status != ERROR_SUCCESS) {
        SetLastError(status);
        throw Win32Error("read filesystem sandbox ACL");
    }
    if (old_acl == nullptr) {
        LocalFree(descriptor);
        throw std::runtime_error("sandbox cannot safely modify a null DACL");
    }
    try {
        if (mode != REVOKE_ACCESS) RecordSandboxAcl(root, capability_sid);
    } catch (...) {
        LocalFree(descriptor);
        throw;
    }
    EXPLICIT_ACCESSW access{};
    access.grfAccessPermissions = permissions;
    access.grfAccessMode = mode;
    access.grfInheritance = inheritance;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    access.Trustee.ptstrName = static_cast<LPWSTR>(capability_sid);
    PACL updated_acl = nullptr;
    status = mode == REVOKE_ACCESS
        ? RemoveSandboxAces(old_acl, capability_sid)
        : SetEntriesInAclW(1, &access, old_acl, &updated_acl);
    if (status == ERROR_SUCCESS) {
        status = SetSecurityInfo(
            guard.leaf(), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION, nullptr, nullptr,
            mode == REVOKE_ACCESS ? old_acl : updated_acl, nullptr);
    }
    if (updated_acl != nullptr) LocalFree(updated_acl);
    if (descriptor != nullptr) LocalFree(descriptor);
    if (status != ERROR_SUCCESS) {
        SetLastError(status);
        throw Win32Error("set filesystem sandbox ACL");
    }
}
}  // namespace

void GrantWritableRoot(const std::filesystem::path& root, PSID capability_sid) {
    UpdatePathAcl(
        root,
        capability_sid,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE,
        GRANT_ACCESS,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT);
}

void GrantReadableRoot(const std::filesystem::path& root, PSID account_sid) {
    // Node and other runtimes stat every ancestor while resolving absolute paths.
    // Grant only traversal/metadata on private parents, without enumerating their
    // children or inheriting access into sibling directories. Public ancestors
    // already grant these rights and need no DACL modification by the host.
    constexpr DWORD parent_permissions = FILE_TRAVERSE | FILE_READ_ATTRIBUTES;
    auto parent = root.parent_path();
    while (!parent.empty()) {
        if (!HasPathAccess(parent, account_sid, parent_permissions)) {
            UpdatePathAcl(parent, account_sid, parent_permissions, GRANT_ACCESS, NO_INHERITANCE);
        }
        const auto next = parent.parent_path();
        if (next == parent) break;
        parent = next;
    }
    constexpr DWORD read_permissions = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    if (!HasPathAccess(root, account_sid, read_permissions)) {
        // Preserve grants used by concurrent commands. The restricted token
        // supplies each command's write boundary, not a mutable account DACL.
        UpdatePathAcl(root, account_sid, read_permissions, GRANT_ACCESS,
            SUB_CONTAINERS_AND_OBJECTS_INHERIT);
    }
}

void DenyReadPath(const std::filesystem::path& path, PSID capability_sid) {
    UpdatePathAcl(
        path,
        capability_sid,
        FILE_GENERIC_READ | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA |
            FILE_WRITE_ATTRIBUTES | DELETE | FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER,
        DENY_ACCESS,
        std::filesystem::is_directory(path)
            ? SUB_CONTAINERS_AND_OBJECTS_INHERIT
            : NO_INHERITANCE);
}

void DenyDeleteChildPath(const std::filesystem::path& path, PSID sid) {
    UpdatePathAcl(path, sid, FILE_DELETE_CHILD, DENY_ACCESS, NO_INHERITANCE);
}

void DenyWritePath(const std::filesystem::path& path, PSID capability_sid, bool inherit) {
    // FILE_GENERIC_WRITE also contains READ_CONTROL and SYNCHRONIZE, which
    // readers request too. Deny only mutation rights so git can read metadata.
    UpdatePathAcl(
        path,
        capability_sid,
        FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES |
            DELETE | FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER,
        DENY_ACCESS,
        inherit && std::filesystem::is_directory(path)
            ? SUB_CONTAINERS_AND_OBJECTS_INHERIT
            : NO_INHERITANCE);
}

void RevokeSandboxAccess(const std::filesystem::path& path, PSID sid) {
    UpdatePathAcl(path, sid, 0, REVOKE_ACCESS, NO_INHERITANCE);
}
}  // namespace mycli::sandbox
