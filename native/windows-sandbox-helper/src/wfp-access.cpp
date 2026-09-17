#include "wfp-access.hpp"

#include <aclapi.h>
#include <fwpmu.h>
#include <fstream>
#include <nlohmann/json.hpp>
#include <vector>
#include "path-guard.hpp"

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
    if (descriptor != nullptr) FwpmFreeMemory0(&descriptor);
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
    if (descriptor != nullptr) FwpmFreeMemory0(&descriptor);
    return found;
}

template <typename Read>
DWORD OwnerMask(Read read, PSID owner) {
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const DWORD status = read(&acl, &descriptor);
    if (status == static_cast<DWORD>(FWP_E_PROVIDER_NOT_FOUND)) return 0;
    if (status != ERROR_SUCCESS) throw std::runtime_error("could not inspect WFP recovery ACL");
    DWORD mask = 0;
    if (acl != nullptr) {
        for (DWORD index = 0; index < acl->AceCount; ++index) {
            void* raw = nullptr;
            if (GetAce(acl, index, &raw) == 0) break;
            const auto* header = static_cast<ACE_HEADER*>(raw);
            if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || (header->AceFlags & INHERITED_ACE) != 0) continue;
            const auto* entry = static_cast<ACCESS_ALLOWED_ACE*>(raw);
            if (EqualSid(const_cast<DWORD*>(&entry->SidStart), owner) != 0) mask |= entry->Mask;
        }
    }
    if (descriptor != nullptr) FwpmFreeMemory0(&descriptor);
    return mask;
}

template <typename Read, typename Write>
void RemoveAddedRights(Read read, Write write, PSID owner, DWORD added) {
    if (added == 0) return;
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD status = read(&acl, &descriptor);
    if (status == static_cast<DWORD>(FWP_E_PROVIDER_NOT_FOUND)) return;
    if (status != ERROR_SUCCESS) throw std::runtime_error("could not read WFP recovery ACL");
    if (acl != nullptr) {
        // Change only added bits in this owner's explicit allow ACEs. Preserve
        // deny ACEs, other users, and unrelated permissions changed since setup.
        for (DWORD index = 0; index < acl->AceCount;) {
            void* raw = nullptr;
            if (GetAce(acl, index, &raw) == 0) { status = GetLastError(); break; }
            auto* header = static_cast<ACE_HEADER*>(raw);
            if (header->AceType == ACCESS_ALLOWED_ACE_TYPE && (header->AceFlags & INHERITED_ACE) == 0) {
                auto* entry = static_cast<ACCESS_ALLOWED_ACE*>(raw);
                if (EqualSid(&entry->SidStart, owner) != 0) {
                    entry->Mask &= ~added;
                    if (entry->Mask == 0) {
                        if (DeleteAce(acl, index) == 0) { status = GetLastError(); break; }
                        continue;
                    }
                }
            }
            ++index;
        }
        if (status == ERROR_SUCCESS) status = write(acl);
    }
    if (descriptor != nullptr) FwpmFreeMemory0(&descriptor);
    if (status != ERROR_SUCCESS) throw std::runtime_error("could not restore WFP proxy access");
}

void SaveRecoveryMasks(const std::filesystem::path& directory, DWORD engine_added, DWORD provider_added) {
    const PathGuard guard{directory};
    const auto path = directory / L"proxy-access.v1.json";
    if (std::filesystem::exists(path)) {
        const PathGuard existing{path};
        return;
    }
    const auto temporary = directory / L"proxy-access.v1.tmp";
    if (DeleteFileW(temporary.c_str()) == 0 && GetLastError() != ERROR_FILE_NOT_FOUND) {
        throw Win32Error("remove temporary WFP recovery state");
    }
    const auto data = nlohmann::json{{"engine_added", engine_added}, {"provider_added", provider_added}}.dump();
    {
        const UniqueHandle file{CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
        if (!file) throw Win32Error("create WFP recovery state");
        DWORD written = 0;
        if (WriteFile(file.get(), data.data(), static_cast<DWORD>(data.size()), &written, nullptr) == 0 ||
            written != data.size() || FlushFileBuffers(file.get()) == 0) throw Win32Error("persist WFP recovery state");
    }
    if (MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_WRITE_THROUGH) == 0) {
        throw Win32Error("publish WFP recovery state");
    }
}

}  // namespace

void GrantWfpProxyAccess(HANDLE engine, const GUID& provider, const GUID& sublayer, PSID owner,
    const std::filesystem::path& state_directory) {
    const auto engine_read = [&](PACL* acl, PSECURITY_DESCRIPTOR* sd) { return FwpmEngineGetSecurityInfo0(
        engine, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr, sd); };
    const auto provider_read = [&](PACL* acl, PSECURITY_DESCRIPTOR* sd) { return FwpmProviderGetSecurityInfoByKey0(
        engine, &provider, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr, sd); };
    SaveRecoveryMasks(state_directory, (FWPM_ACTRL_ADD | READ_CONTROL) & ~OwnerMask(engine_read, owner),
        (FWPM_ACTRL_ADD_LINK | READ_CONTROL) & ~OwnerMask(provider_read, owner));
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

void RestoreWfpProxyAccess(HANDLE engine, const GUID& provider, PSID owner,
    const std::filesystem::path& state_directory) {
    const auto path = state_directory / L"proxy-access.v1.json";
    if (!std::filesystem::exists(path)) return;  // No tracked control-plane grant.
    const PathGuard guard{path};
    if (std::filesystem::file_size(path) > 4096) throw std::runtime_error("invalid WFP recovery state");
    std::ifstream input{path, std::ios::binary};
    const auto data = nlohmann::json::parse(input);
    const auto engine_added = data.at("engine_added").get<DWORD>();
    const auto provider_added = data.at("provider_added").get<DWORD>();
    if ((engine_added & ~(FWPM_ACTRL_ADD | READ_CONTROL)) != 0 ||
        (provider_added & ~(FWPM_ACTRL_ADD_LINK | READ_CONTROL)) != 0) {
        throw std::runtime_error("invalid WFP recovery permission mask");
    }
    RemoveAddedRights(
        [&](PACL* acl, PSECURITY_DESCRIPTOR* sd) { return FwpmEngineGetSecurityInfo0(
            engine, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr, sd); },
        [&](PACL acl) { return FwpmEngineSetSecurityInfo0(
            engine, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr); }, owner, engine_added);
    RemoveAddedRights(
        [&](PACL* acl, PSECURITY_DESCRIPTOR* sd) { return FwpmProviderGetSecurityInfoByKey0(
            engine, &provider, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr, sd); },
        [&](PACL acl) { return FwpmProviderSetSecurityInfoByKey0(
            engine, &provider, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr); }, owner, provider_added);
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
