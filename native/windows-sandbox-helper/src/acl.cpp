#include "acl.hpp"
#include "win32.hpp"
#include <aclapi.h>

namespace mycli::sandbox {
void GrantWritableRoot(const std::filesystem::path& root, PSID capability_sid) {
    PACL old_acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const auto path = root.wstring();
    DWORD status = GetNamedSecurityInfoW(
        const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &old_acl, nullptr, &descriptor);
    if (status != ERROR_SUCCESS) throw std::runtime_error("GetNamedSecurityInfoW failed");
    EXPLICIT_ACCESSW access{};
    access.grfAccessPermissions = FILE_GENERIC_READ | FILE_GENERIC_WRITE |
        FILE_GENERIC_EXECUTE | DELETE;
    access.grfAccessMode = GRANT_ACCESS;
    access.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    access.Trustee.ptstrName = static_cast<LPWSTR>(capability_sid);
    PACL updated_acl = nullptr;
    status = SetEntriesInAclW(1, &access, old_acl, &updated_acl);
    if (status == ERROR_SUCCESS) {
        status = SetNamedSecurityInfoW(
            const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION, nullptr, nullptr, updated_acl, nullptr);
    }
    if (updated_acl != nullptr) LocalFree(updated_acl);
    if (descriptor != nullptr) LocalFree(descriptor);
    if (status != ERROR_SUCCESS) throw std::runtime_error("setting writable ACL failed");
}
}  // namespace mycli::sandbox
