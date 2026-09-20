#include "desktop.hpp"

#include <aclapi.h>
#include <rpc.h>
#include <vector>

#include "identity.hpp"
#include "sid.hpp"
#include "token.hpp"
#include "win32.hpp"

namespace mycli::sandbox {
namespace {
std::wstring ObjectName(HANDLE object) {
    DWORD bytes = 0;
    GetUserObjectInformationW(object, UOI_NAME, nullptr, 0, &bytes);
    if (bytes == 0) throw Win32Error("GetUserObjectInformationW(size)");
    std::vector<wchar_t> buffer(bytes / sizeof(wchar_t) + 1);
    if (GetUserObjectInformationW(object, UOI_NAME, buffer.data(), bytes, &bytes) == 0) {
        throw Win32Error("GetUserObjectInformationW(name)");
    }
    return buffer.data();
}
}  // namespace

std::wstring CurrentDesktopName() {
    return ObjectName(GetProcessWindowStation()) + L"\\" +
        ObjectName(GetThreadDesktop(GetCurrentThreadId()));
}

PrivateDesktop::PrivateDesktop(PSID account_sid) {
    UUID id{};
    const auto uuid_status = UuidCreate(&id);
    if (uuid_status != RPC_S_OK && uuid_status != RPC_S_UUID_LOCAL_ONLY) {
        throw std::runtime_error("private desktop ID unavailable");
    }
    RPC_WSTR raw_name = nullptr;
    if (UuidToStringW(&id, &raw_name) != RPC_S_OK) {
        throw std::runtime_error("private desktop ID conversion failed");
    }
    const std::wstring short_name = L"MycliSandbox-" + std::wstring{reinterpret_cast<const wchar_t*>(raw_name)};
    RpcStringFreeW(&raw_name);
    name_ = ObjectName(GetProcessWindowStation()) + L"\\" + short_name;
    const auto owner = SidFromString(CurrentUserSidString());
    const auto system = SidFromString(L"S-1-5-18");
    constexpr DWORD participant = DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW |
        DESKTOP_CREATEMENU | DESKTOP_HOOKCONTROL | DESKTOP_JOURNALRECORD |
        DESKTOP_JOURNALPLAYBACK | DESKTOP_ENUMERATE | DESKTOP_WRITEOBJECTS | READ_CONTROL;
    EXPLICIT_ACCESSW entries[3]{};
    const PSID sids[] = {owner.get(), system.get(), account_sid};
    for (std::size_t index = 0; index < 3; ++index) {
        entries[index].grfAccessPermissions = index == 2 ? participant : GENERIC_ALL;
        entries[index].grfAccessMode = SET_ACCESS;
        entries[index].grfInheritance = NO_INHERITANCE;
        BuildTrusteeWithSidW(&entries[index].Trustee, sids[index]);
    }
    PACL acl = nullptr;
    const DWORD status = SetEntriesInAclW(3, entries, nullptr, &acl);
    if (status != ERROR_SUCCESS) {
        SetLastError(status);
        throw Win32Error("SetEntriesInAclW(private desktop)");
    }
    SECURITY_DESCRIPTOR descriptor{};
    if (InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) == 0 ||
        SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE) == 0) {
        LocalFree(acl);
        throw Win32Error("private desktop security descriptor");
    }
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), &descriptor, FALSE};
    handle_ = CreateDesktopW(short_name.c_str(), nullptr, nullptr, 0,
        GENERIC_ALL, &attributes);
    const DWORD error = GetLastError();
    LocalFree(acl);
    if (handle_ == nullptr) {
        SetLastError(error);
        throw Win32Error("CreateDesktopW(private sandbox)");
    }
}

void PrivateDesktop::AllowLogon(HANDLE process) const {
    HANDLE raw_token = nullptr;
    if (OpenProcessToken(process, TOKEN_QUERY, &raw_token) == 0) {
        throw Win32Error("OpenProcessToken(private desktop)");
    }
    const UniqueHandle token{raw_token};
    auto logon = CopyTokenLogonSid(token.get());
    PACL old_acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD status = GetSecurityInfo(handle_, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &old_acl, nullptr, &descriptor);
    if (status != ERROR_SUCCESS) {
        SetLastError(status);
        throw Win32Error("read private desktop ACL");
    }
    EXPLICIT_ACCESSW entry{};
    entry.grfAccessPermissions = DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW |
        DESKTOP_CREATEMENU | DESKTOP_HOOKCONTROL | DESKTOP_JOURNALRECORD |
        DESKTOP_JOURNALPLAYBACK | DESKTOP_ENUMERATE | DESKTOP_WRITEOBJECTS | READ_CONTROL;
    entry.grfAccessMode = GRANT_ACCESS;
    BuildTrusteeWithSidW(&entry.Trustee, logon.data());
    PACL updated = nullptr;
    status = SetEntriesInAclW(1, &entry, old_acl, &updated);
    if (status == ERROR_SUCCESS) {
        status = SetSecurityInfo(handle_, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION,
            nullptr, nullptr, updated, nullptr);
    }
    if (updated != nullptr) LocalFree(updated);
    LocalFree(descriptor);
    if (status != ERROR_SUCCESS) {
        SetLastError(status);
        throw Win32Error("grant sandbox logon private desktop access");
    }
}

void PrivateDesktop::AllowAppContainer(HANDLE process) const {
    HANDLE raw_token = nullptr;
    if (OpenProcessToken(process, TOKEN_QUERY, &raw_token) == 0) {
        throw Win32Error("OpenProcessToken(PSEC desktop)");
    }
    const UniqueHandle token{raw_token};
    DWORD size = 0;
    GetTokenInformation(token.get(), TokenAppContainerSid, nullptr, 0, &size);
    std::vector<std::byte> buffer(size);
    if (GetTokenInformation(token.get(), TokenAppContainerSid, buffer.data(), size, &size) == 0) {
        throw Win32Error("GetTokenInformation(PSEC desktop)");
    }
    const auto info = reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(buffer.data());
    if (info->TokenAppContainer == nullptr) throw std::runtime_error("PSEC process lacks container SID");
    PACL old_acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD status = GetSecurityInfo(handle_, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &old_acl, nullptr, &descriptor);
    if (status != ERROR_SUCCESS) throw std::runtime_error("read PSEC desktop ACL failed");
    EXPLICIT_ACCESSW entry{};
    entry.grfAccessPermissions = DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW |
        DESKTOP_CREATEMENU | DESKTOP_ENUMERATE | DESKTOP_WRITEOBJECTS | READ_CONTROL;
    entry.grfAccessMode = GRANT_ACCESS;
    BuildTrusteeWithSidW(&entry.Trustee, info->TokenAppContainer);
    PACL updated = nullptr;
    status = SetEntriesInAclW(1, &entry, old_acl, &updated);
    if (status == ERROR_SUCCESS) {
        status = SetSecurityInfo(handle_, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION,
            nullptr, nullptr, updated, nullptr);
    }
    if (updated != nullptr) LocalFree(updated);
    LocalFree(descriptor);
    if (status != ERROR_SUCCESS) throw std::runtime_error("grant PSEC desktop access failed");
}

PrivateDesktop::~PrivateDesktop() {
    if (handle_ != nullptr) CloseDesktop(handle_);
}

}  // namespace mycli::sandbox
