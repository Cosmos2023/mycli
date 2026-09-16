#include "wfp-access.hpp"

#include <aclapi.h>
#include <fwpmu.h>

#include "win32.hpp"

namespace mycli::sandbox {
namespace {

// The host can add transient filters only to its own account's sublayer.
// Restricted accounts receive no WFP control-plane permissions.
template <typename Read, typename Write>
void Grant(Read read, Write write, PSID owner, DWORD mask) {
    PACL old_acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD status = read(&old_acl, &descriptor);
    if (status != ERROR_SUCCESS) {
        SetLastError(status);
        throw Win32Error("read WFP object security");
    }
    EXPLICIT_ACCESSW entry{};
    entry.grfAccessPermissions = mask;
    entry.grfAccessMode = GRANT_ACCESS;
    entry.grfInheritance = NO_INHERITANCE;
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
    entry.Trustee.ptstrName = static_cast<LPWSTR>(owner);
    PACL updated = nullptr;
    status = SetEntriesInAclW(1, &entry, old_acl, &updated);
    if (status == ERROR_SUCCESS) status = write(updated);
    if (updated != nullptr) LocalFree(updated);
    if (descriptor != nullptr) LocalFree(descriptor);
    if (status != ERROR_SUCCESS) {
        SetLastError(status);
        throw Win32Error("grant WFP proxy access");
    }
}

template <typename Read>
bool HasGrant(Read read, PSID owner, DWORD mask) {
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (read(&acl, &descriptor) != ERROR_SUCCESS) return false;
    bool found = false;
    if (acl != nullptr) {
        for (DWORD index = 0; index < acl->AceCount; ++index) {
            void* raw = nullptr;
            if (GetAce(acl, index, &raw) == 0) break;
            const auto* header = static_cast<ACE_HEADER*>(raw);
            if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) continue;
            const auto* entry = static_cast<ACCESS_ALLOWED_ACE*>(raw);
            if ((entry->Mask & mask) == mask && EqualSid(
                    const_cast<DWORD*>(&entry->SidStart), owner) != 0) {
                found = true;
                break;
            }
        }
    }
    if (descriptor != nullptr) LocalFree(descriptor);
    return found;
}

}  // namespace

void GrantWfpProxyAccess(HANDLE engine, const GUID& provider, const GUID& sublayer, PSID owner) {
    Grant(
        [&](PACL* acl, PSECURITY_DESCRIPTOR* sd) { return FwpmEngineGetSecurityInfo0(
            engine, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr, sd); },
        [&](PACL acl) { return FwpmEngineSetSecurityInfo0(
            engine, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr); },
        owner, FWPM_ACTRL_ADD | READ_CONTROL);
    Grant(
        [&](PACL* acl, PSECURITY_DESCRIPTOR* sd) { return FwpmProviderGetSecurityInfoByKey0(
            engine, &provider, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr, sd); },
        [&](PACL acl) { return FwpmProviderSetSecurityInfoByKey0(
            engine, &provider, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr); },
        owner, FWPM_ACTRL_ADD_LINK | READ_CONTROL);
    Grant(
        [&](PACL* acl, PSECURITY_DESCRIPTOR* sd) { return FwpmSubLayerGetSecurityInfoByKey0(
            engine, &sublayer, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr, sd); },
        [&](PACL acl) { return FwpmSubLayerSetSecurityInfoByKey0(
            engine, &sublayer, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr); },
        owner, FWPM_ACTRL_ADD_LINK | READ_CONTROL);
}

bool HasWfpProxyAccess(HANDLE engine, const GUID& provider, const GUID& sublayer, PSID owner) {
    return HasGrant([&](PACL* acl, PSECURITY_DESCRIPTOR* sd) { return FwpmEngineGetSecurityInfo0(
        engine, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr, sd); },
        owner, FWPM_ACTRL_ADD | READ_CONTROL)
        && HasGrant([&](PACL* acl, PSECURITY_DESCRIPTOR* sd) { return FwpmProviderGetSecurityInfoByKey0(
            engine, &provider, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr, sd); },
            owner, FWPM_ACTRL_ADD_LINK | READ_CONTROL)
        && HasGrant([&](PACL* acl, PSECURITY_DESCRIPTOR* sd) { return FwpmSubLayerGetSecurityInfoByKey0(
            engine, &sublayer, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr, sd); },
            owner, FWPM_ACTRL_ADD_LINK | READ_CONTROL);
}

}  // namespace mycli::sandbox
