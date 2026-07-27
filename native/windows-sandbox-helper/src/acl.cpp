#include "acl.hpp"
#include "win32.hpp"
#include <aclapi.h>

namespace mycli::sandbox {
namespace {
void UpdatePathAcl(
    const std::filesystem::path& root,
    PSID capability_sid,
    DWORD permissions,
    ACCESS_MODE mode,
    DWORD inheritance) {
    PACL old_acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const auto path = root.wstring();
    DWORD status = GetNamedSecurityInfoW(
        const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &old_acl, nullptr, &descriptor);
    if (status != ERROR_SUCCESS) throw std::runtime_error("GetNamedSecurityInfoW failed");
    PACL base_acl = old_acl;
    PACL revoked_acl = nullptr;
    if (mode == DENY_ACCESS) {
        EXPLICIT_ACCESSW revoke{};
        revoke.grfAccessMode = REVOKE_ACCESS;
        revoke.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        revoke.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        revoke.Trustee.ptstrName = static_cast<LPWSTR>(capability_sid);
        status = SetEntriesInAclW(1, &revoke, old_acl, &revoked_acl);
        if (status != ERROR_SUCCESS) {
            if (descriptor != nullptr) LocalFree(descriptor);
            throw std::runtime_error("failed to canonicalize sandbox ACL");
        }
        base_acl = revoked_acl;
    }
    EXPLICIT_ACCESSW access{};
    access.grfAccessPermissions = permissions;
    access.grfAccessMode = mode;
    access.grfInheritance = inheritance;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    access.Trustee.ptstrName = static_cast<LPWSTR>(capability_sid);
    PACL updated_acl = nullptr;
    status = SetEntriesInAclW(1, &access, base_acl, &updated_acl);
    if (status == ERROR_SUCCESS) {
        status = SetNamedSecurityInfoW(
            const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION, nullptr, nullptr, updated_acl, nullptr);
    }
    if (updated_acl != nullptr) LocalFree(updated_acl);
    if (revoked_acl != nullptr) LocalFree(revoked_acl);
    if (descriptor != nullptr) LocalFree(descriptor);
    if (status != ERROR_SUCCESS) throw std::runtime_error("setting writable ACL failed");
}
}  // namespace

void GrantWritableRoot(const std::filesystem::path& root, PSID capability_sid) {
    UpdatePathAcl(
        root,
        capability_sid,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE,
        SET_ACCESS,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT);
}

void GrantReadableRoot(const std::filesystem::path& root, PSID account_sid) {
    UpdatePathAcl(
        root,
        account_sid,
        FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
        SET_ACCESS,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT);
}

void DenyReadPath(const std::filesystem::path& path, PSID capability_sid) {
    UpdatePathAcl(
        path,
        capability_sid,
        FILE_GENERIC_READ,
        DENY_ACCESS,
        std::filesystem::is_directory(path)
            ? SUB_CONTAINERS_AND_OBJECTS_INHERIT
            : NO_INHERITANCE);
}

void DenyWritePath(const std::filesystem::path& path, PSID capability_sid) {
    UpdatePathAcl(
        path,
        capability_sid,
        FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD,
        DENY_ACCESS,
        std::filesystem::is_directory(path)
            ? SUB_CONTAINERS_AND_OBJECTS_INHERIT
            : NO_INHERITANCE);
}
}  // namespace mycli::sandbox
