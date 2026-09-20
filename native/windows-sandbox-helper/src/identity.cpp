#include "identity.hpp"

#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <dpapi.h>
#include <lm.h>
#include <ntsecapi.h>
#include <sddl.h>
#include <shlobj.h>
#include <userenv.h>
#include "path-guard.hpp"

#include <array>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <utility>
#include <vector>

#include "process.hpp"

namespace mycli::sandbox {
namespace {

constexpr std::array<unsigned char, 16> kCredentialMagic{
    'M', 'Y', 'C', 'L', 'I', 'W', 'S', 'C', 'R', 'E', 'D', '0', '0', '0', '0', '1'};
constexpr wchar_t kCredentialDescription[] = L"mycli Windows sandbox credential";
constexpr wchar_t kDpapiEntropy[] = L"mycli/windows-sandbox/credential/v1";

std::filesystem::path StateDirectory() {
    PWSTR raw_path = nullptr;
    if (SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE, nullptr, &raw_path) != S_OK) {
        throw std::runtime_error("SHGetKnownFolderPath(LocalAppData) failed");
    }
    const std::filesystem::path path =
        std::filesystem::path{raw_path} / L"mycli" / L"sandbox";
    CoTaskMemFree(raw_path);
    return path;
}

std::filesystem::path CredentialPath(
    const std::filesystem::path& state_directory, SandboxIdentityKind kind) {
    switch (kind) {
        case SandboxIdentityKind::kOffline: return state_directory / L"offline.credential";
        case SandboxIdentityKind::kOnline: return state_directory / L"online.credential";
        case SandboxIdentityKind::kProxy: return state_directory / L"proxy.credential";
    }
    throw std::invalid_argument("unknown sandbox identity kind");
}

void RequireAdministrator() {
    SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
    PSID administrators = nullptr;
    if (AllocateAndInitializeSid(
            &authority,
            2,
            SECURITY_BUILTIN_DOMAIN_RID,
            DOMAIN_ALIAS_RID_ADMINS,
            0, 0, 0, 0, 0, 0,
            &administrators) == 0) {
        throw Win32Error("AllocateAndInitializeSid(Administrators)");
    }
    BOOL member = FALSE;
    const BOOL checked = CheckTokenMembership(nullptr, administrators, &member);
    FreeSid(administrators);
    if (checked == 0) throw Win32Error("CheckTokenMembership(Administrators)");
    if (member == FALSE) throw std::runtime_error("Windows sandbox setup requires elevation");
}

std::wstring SidStringFromToken(HANDLE token) {
    DWORD bytes = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        throw Win32Error("GetTokenInformation(TokenUser size)");
    }
    std::vector<unsigned char> storage(bytes);
    if (GetTokenInformation(
            token, TokenUser, storage.data(), bytes, &bytes) == 0) {
        throw Win32Error("GetTokenInformation(TokenUser)");
    }
    const auto* token_user = reinterpret_cast<const TOKEN_USER*>(storage.data());
    LPWSTR raw_sid = nullptr;
    if (ConvertSidToStringSidW(token_user->User.Sid, &raw_sid) == 0) {
        throw Win32Error("ConvertSidToStringSidW(current user)");
    }
    const std::wstring sid{raw_sid};
    LocalFree(raw_sid);
    return sid;
}

LocalSid WellKnownSid(WELL_KNOWN_SID_TYPE type) {
    DWORD bytes = SECURITY_MAX_SID_SIZE;
    auto* raw_sid = static_cast<PSID>(LocalAlloc(LMEM_FIXED, bytes));
    if (raw_sid == nullptr) throw Win32Error("LocalAlloc(well-known SID)");
    if (CreateWellKnownSid(type, nullptr, raw_sid, &bytes) == 0) {
        LocalFree(raw_sid);
        throw Win32Error("CreateWellKnownSid");
    }
    return LocalSid{raw_sid};
}

EXPLICIT_ACCESSW FullControlEntry(PSID sid, DWORD inheritance) {
    EXPLICIT_ACCESSW entry{};
    entry.grfAccessPermissions = FILE_ALL_ACCESS;
    entry.grfAccessMode = SET_ACCESS;
    entry.grfInheritance = inheritance;
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    entry.Trustee.ptstrName = static_cast<LPWSTR>(sid);
    return entry;
}

void RestrictStatePath(
    const std::filesystem::path& path,
    const std::wstring& owner_sid,
    DWORD inheritance) {
    auto owner = SidFromString(owner_sid);
    auto system = WellKnownSid(WinLocalSystemSid);
    auto administrators = WellKnownSid(WinBuiltinAdministratorsSid);
    std::array<EXPLICIT_ACCESSW, 3> entries{
        FullControlEntry(owner.get(), inheritance),
        FullControlEntry(system.get(), inheritance),
        FullControlEntry(administrators.get(), inheritance)};
    PACL acl = nullptr;
    const DWORD acl_status = SetEntriesInAclW(
        static_cast<ULONG>(entries.size()), entries.data(), nullptr, &acl);
    if (acl_status != ERROR_SUCCESS) {
        SetLastError(acl_status);
        throw Win32Error("SetEntriesInAclW(state path)");
    }
    const PathGuard guard{path, READ_CONTROL | WRITE_DAC};
    const DWORD security_status = SetSecurityInfo(
        guard.leaf(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr,
        nullptr,
        acl,
        nullptr);
    LocalFree(acl);
    if (security_status != ERROR_SUCCESS) {
        SetLastError(security_status);
        throw Win32Error("SetNamedSecurityInfoW(state path)");
    }
}

void PrepareStateDirectory(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid) {
    std::filesystem::create_directories(state_directory);
    RestrictStatePath(
        state_directory,
        owner_sid,
        CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE);
}

std::wstring GeneratePassword() {
    std::array<unsigned char, 24> random{};
    if (BCryptGenRandom(
            nullptr,
            random.data(),
            static_cast<ULONG>(random.size()),
            BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
        throw std::runtime_error("BCryptGenRandom failed");
    }
    constexpr wchar_t hex[] = L"0123456789abcdef";
    std::wstring password = L"Mycli!9aA-";
    password.reserve(password.size() + random.size() * 2);
    for (const auto byte : random) {
        password.push_back(hex[byte >> 4]);
        password.push_back(hex[byte & 0x0f]);
    }
    return password;
}

std::pair<LocalSid, std::wstring> LookupOfflineSid(const std::wstring& username) {
    DWORD sid_bytes = 0;
    DWORD domain_chars = 0;
    SID_NAME_USE sid_type{};
    LookupAccountNameW(
        nullptr, username.c_str(), nullptr, &sid_bytes, nullptr, &domain_chars, &sid_type);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        throw Win32Error("LookupAccountNameW(size)");
    }
    std::vector<unsigned char> sid_storage(sid_bytes);
    std::vector<wchar_t> domain(domain_chars);
    if (LookupAccountNameW(
            nullptr,
            username.c_str(),
            sid_storage.data(),
            &sid_bytes,
            domain.data(),
            &domain_chars,
            &sid_type) == 0) {
        throw Win32Error("LookupAccountNameW");
    }
    LPWSTR raw_sid_string = nullptr;
    if (ConvertSidToStringSidW(sid_storage.data(), &raw_sid_string) == 0) {
        throw Win32Error("ConvertSidToStringSidW");
    }
    const std::wstring sid_string{raw_sid_string};
    LocalFree(raw_sid_string);
    return {SidFromString(sid_string), sid_string};
}

void GrantLogonRights(PSID sid) {
    LSA_OBJECT_ATTRIBUTES attributes{};
    attributes.Length = sizeof(attributes);
    LSA_HANDLE policy = nullptr;
    NTSTATUS status = LsaOpenPolicy(
        nullptr,
        &attributes,
        POLICY_LOOKUP_NAMES | POLICY_CREATE_ACCOUNT,
        &policy);
    if (status != 0) {
        SetLastError(LsaNtStatusToWinError(status));
        throw Win32Error("LsaOpenPolicy");
    }
    std::array<std::wstring, 2> names{
        L"SeBatchLogonRight",
        L"SeDenyRemoteInteractiveLogonRight"};
    std::array<LSA_UNICODE_STRING, 2> rights{};
    for (std::size_t index = 0; index < names.size(); ++index) {
        rights[index].Buffer = names[index].data();
        rights[index].Length = static_cast<USHORT>(names[index].size() * sizeof(wchar_t));
        rights[index].MaximumLength = rights[index].Length;
    }
    status = LsaAddAccountRights(
        policy, sid, rights.data(), static_cast<ULONG>(rights.size()));
    if (status != 0) {
        LsaClose(policy);
        SetLastError(LsaNtStatusToWinError(status));
        throw Win32Error("LsaAddAccountRights");
    }
    std::wstring removed_name = L"SeDenyInteractiveLogonRight";
    LSA_UNICODE_STRING removed_right{
        static_cast<USHORT>(removed_name.size() * sizeof(wchar_t)),
        static_cast<USHORT>(removed_name.size() * sizeof(wchar_t)),
        removed_name.data()};
    status = LsaRemoveAccountRights(policy, sid, FALSE, &removed_right, 1);
    LsaClose(policy);
    if (status != 0) {
        SetLastError(LsaNtStatusToWinError(status));
        throw Win32Error("LsaRemoveAccountRights(SeDenyInteractiveLogonRight)");
    }
}

std::vector<unsigned char> ProtectPassword(const std::wstring& password) {
    DATA_BLOB input{
        static_cast<DWORD>(password.size() * sizeof(wchar_t)),
        reinterpret_cast<BYTE*>(const_cast<wchar_t*>(password.data()))};
    DATA_BLOB entropy{
        static_cast<DWORD>((std::size(kDpapiEntropy) - 1) * sizeof(wchar_t)),
        reinterpret_cast<BYTE*>(const_cast<wchar_t*>(kDpapiEntropy))};
    DATA_BLOB output{};
    if (CryptProtectData(
            &input,
            kCredentialDescription,
            &entropy,
            nullptr,
            nullptr,
            CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE,
            &output) == 0) {
        throw Win32Error("CryptProtectData");
    }
    std::vector<unsigned char> protected_data(output.pbData, output.pbData + output.cbData);
    LocalFree(output.pbData);
    return protected_data;
}

void SavePassword(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid,
    SandboxIdentityKind kind,
    const std::wstring& password) {
    PrepareStateDirectory(state_directory, owner_sid);
    const auto target = CredentialPath(state_directory, kind);
    const std::filesystem::path temporary = target.wstring() + L".tmp";
    const auto protected_data = ProtectPassword(password);
    std::ofstream output{temporary, std::ios::binary | std::ios::trunc};
    output.write(
        reinterpret_cast<const char*>(kCredentialMagic.data()),
        static_cast<std::streamsize>(kCredentialMagic.size()));
    output.write(
        reinterpret_cast<const char*>(protected_data.data()),
        static_cast<std::streamsize>(protected_data.size()));
    output.close();
    if (!output) throw std::runtime_error("failed to persist sandbox credential");
    std::error_code error;
    std::filesystem::remove(target, error);
    std::filesystem::rename(temporary, target);
    RestrictStatePath(target, owner_sid, NO_INHERITANCE);
}

std::wstring LoadPassword(
    const std::filesystem::path& state_directory, SandboxIdentityKind kind) {
    std::ifstream input{CredentialPath(state_directory, kind), std::ios::binary};
    const std::vector<unsigned char> data{
        std::istreambuf_iterator<char>{input}, std::istreambuf_iterator<char>{}};
    if (data.size() <= kCredentialMagic.size() ||
        !std::equal(kCredentialMagic.begin(), kCredentialMagic.end(), data.begin())) {
        throw std::runtime_error("sandbox credential is missing or invalid");
    }
    DATA_BLOB encrypted{
        static_cast<DWORD>(data.size() - kCredentialMagic.size()),
        const_cast<BYTE*>(data.data() + kCredentialMagic.size())};
    DATA_BLOB entropy{
        static_cast<DWORD>((std::size(kDpapiEntropy) - 1) * sizeof(wchar_t)),
        reinterpret_cast<BYTE*>(const_cast<wchar_t*>(kDpapiEntropy))};
    DATA_BLOB decrypted{};
    if (CryptUnprotectData(
            &encrypted,
            nullptr,
            &entropy,
            nullptr,
            nullptr,
            CRYPTPROTECT_UI_FORBIDDEN,
            &decrypted) == 0) {
        throw Win32Error("CryptUnprotectData");
    }
    if (decrypted.cbData % sizeof(wchar_t) != 0) {
        LocalFree(decrypted.pbData);
        throw std::runtime_error("sandbox credential has invalid length");
    }
    const auto* chars = reinterpret_cast<const wchar_t*>(decrypted.pbData);
    std::wstring password(chars, decrypted.cbData / sizeof(wchar_t));
    SecureZeroMemory(decrypted.pbData, decrypted.cbData);
    LocalFree(decrypted.pbData);
    return password;
}

std::wstring OwnershipComment(const std::wstring& owner_sid) {
    return L"mycli sandbox owner=" + owner_sid;
}

bool RequireOwnedAccount(const std::filesystem::path& state_directory,
    const std::wstring& owner_sid, SandboxIdentityKind kind) {
    const auto username = SandboxUsernameForOwner(owner_sid, kind);
    LPBYTE raw = nullptr;
    const auto status = NetUserGetInfo(nullptr, username.c_str(), 1, &raw);
    if (status == NERR_UserNotFound) return false;
    if (status != NERR_Success) throw std::runtime_error("could not inspect sandbox account ownership");
    const auto* user = reinterpret_cast<const USER_INFO_1*>(raw);
    const std::wstring comment = user->usri1_comment == nullptr ? L"" : user->usri1_comment;
    NetApiBufferFree(raw);
    const auto expected = OwnershipComment(owner_sid);
    if (comment == expected) return true;
    // Migrate a legacy account only if its protected saved credential still
    // authenticates as the expected SID. A matching username is not ownership.
    if (!comment.empty()) throw std::runtime_error("sandbox account name belongs to another account");
    const auto identity = LoadSandboxIdentity(state_directory, owner_sid, kind);
    static_cast<void>(identity);
    USER_INFO_1007 info{const_cast<LPWSTR>(expected.c_str())};
    DWORD parameter = 0;
    if (NetUserSetInfo(nullptr, username.c_str(), 1007, reinterpret_cast<LPBYTE>(&info), &parameter) != NERR_Success) {
        throw std::runtime_error("could not mark legacy sandbox account ownership");
    }
    return true;
}

void CreateOrResetAccount(
    const std::wstring& username,
    const std::wstring& password,
    const std::wstring& owner_sid) {
    USER_INFO_1 user{};
    user.usri1_name = const_cast<LPWSTR>(username.c_str());
    user.usri1_password = const_cast<LPWSTR>(password.c_str());
    user.usri1_priv = USER_PRIV_USER;
    auto comment = OwnershipComment(owner_sid);
    user.usri1_comment = comment.data();
    user.usri1_flags = UF_SCRIPT | UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE;
    DWORD parameter_error = 0;
    NET_API_STATUS status = NetUserAdd(nullptr, 1, reinterpret_cast<LPBYTE>(&user), &parameter_error);
    if (status == NERR_UserExists) {
        USER_INFO_1003 password_info{const_cast<LPWSTR>(password.c_str())};
        status = NetUserSetInfo(
            nullptr,
            username.c_str(),
            1003,
            reinterpret_cast<LPBYTE>(&password_info),
            &parameter_error);
    }
    if (status == NERR_Success) {
        USER_INFO_1008 flags{UF_SCRIPT | UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE};
        status = NetUserSetInfo(nullptr, username.c_str(), 1008, reinterpret_cast<LPBYTE>(&flags), &parameter_error);
    }
    if (status != NERR_Success) {
        throw std::runtime_error(
            "failed to create sandbox account: NetAPI status " + std::to_string(status));
    }
}

}  // namespace

bool SandboxIdentityCredentialsExist(
    const std::filesystem::path& state_directory, SandboxIdentityKind kind) {
    std::error_code error;
    return std::filesystem::is_regular_file(CredentialPath(state_directory, kind), error);
}

std::filesystem::path SandboxStateDirectory() {
    return StateDirectory();
}

void PrepareSandboxStateDirectory(const std::filesystem::path& directory, const std::wstring& owner_sid) {
    PrepareStateDirectory(directory, owner_sid);
}

std::wstring TokenUserSidString(HANDLE token) { return SidStringFromToken(token); }

std::vector<std::wstring> OwnedSandboxAccountSids(
    const std::filesystem::path& directory, const std::wstring& owner_sid) {
    std::vector<std::wstring> result;
    for (const auto kind : {SandboxIdentityKind::kOffline, SandboxIdentityKind::kOnline, SandboxIdentityKind::kProxy}) {
        if (RequireOwnedAccount(directory, owner_sid, kind)) {
            const auto [sid, text] = LookupOfflineSid(SandboxUsernameForOwner(owner_sid, kind));
            result.push_back(text);
        }
    }
    return result;
}

bool SandboxAccountsExist(const std::wstring& owner_sid) {
    for (const auto kind : {SandboxIdentityKind::kOffline, SandboxIdentityKind::kOnline, SandboxIdentityKind::kProxy}) {
        const auto username = SandboxUsernameForOwner(owner_sid, kind);
        LPBYTE raw = nullptr;
        const auto status = NetUserGetInfo(nullptr, username.c_str(), 0, &raw);
        if (raw != nullptr) NetApiBufferFree(raw);
        if (status != NERR_UserNotFound) return true;  // Ambiguity is never uninstall success.
    }
    return false;
}

void DisableSandboxAccounts(const std::filesystem::path& directory, const std::wstring& owner_sid) {
    RequireAdministrator();
    for (const auto kind : {SandboxIdentityKind::kOffline, SandboxIdentityKind::kOnline, SandboxIdentityKind::kProxy}) {
        if (!RequireOwnedAccount(directory, owner_sid, kind)) continue;
        const auto username = SandboxUsernameForOwner(owner_sid, kind);
        USER_INFO_1008 info{UF_SCRIPT | UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE | UF_ACCOUNTDISABLE};
        DWORD parameter = 0;
        if (NetUserSetInfo(nullptr, username.c_str(), 1008, reinterpret_cast<LPBYTE>(&info), &parameter) != NERR_Success) {
            throw std::runtime_error("could not disable sandbox account");
        }
    }
}

void DeleteSandboxAccounts(const std::filesystem::path& directory, const std::wstring& owner_sid) {
    RequireAdministrator();
    for (const auto kind : {SandboxIdentityKind::kOffline, SandboxIdentityKind::kOnline, SandboxIdentityKind::kProxy}) {
        if (!RequireOwnedAccount(directory, owner_sid, kind)) continue;
        const auto username = SandboxUsernameForOwner(owner_sid, kind);
        const auto [sid, sid_string] = LookupOfflineSid(username);
        if (DeleteProfileW(sid_string.c_str(), nullptr, nullptr) == 0 &&
            GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND) {
            throw Win32Error("delete sandbox account profile");
        }
        LSA_OBJECT_ATTRIBUTES attributes{};
        attributes.Length = sizeof(attributes);
        LSA_HANDLE policy = nullptr;
        auto status = LsaOpenPolicy(nullptr, &attributes, POLICY_LOOKUP_NAMES, &policy);
        if (status != 0) throw std::runtime_error("could not open sandbox account logon rights");
        status = LsaRemoveAccountRights(policy, sid.get(), TRUE, nullptr, 0);
        LsaClose(policy);
        if (status != 0 && LsaNtStatusToWinError(status) != ERROR_FILE_NOT_FOUND) {
            throw std::runtime_error("could not remove sandbox account logon rights");
        }
        const auto result = NetUserDel(nullptr, username.c_str());
        if (result != NERR_Success && result != NERR_UserNotFound) {
            throw std::runtime_error("could not delete sandbox account");
        }
    }
}

std::wstring CurrentUserSidString() {
    HANDLE raw_token = nullptr;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token) == 0) {
        throw Win32Error("OpenProcessToken(current user)");
    }
    const UniqueHandle token{raw_token};
    return SidStringFromToken(token.get());
}

std::wstring SandboxUsernameForOwner(
    const std::wstring& owner_sid, SandboxIdentityKind kind) {
    static_cast<void>(SidFromString(owner_sid));
    const auto digest = HashSandboxKey(owner_sid);
    constexpr wchar_t hex[] = L"0123456789abcdef";
    std::wstring username = kind == SandboxIdentityKind::kOffline ? L"mcli_"
        : kind == SandboxIdentityKind::kOnline ? L"mclo_" : L"mclp_";
    for (std::size_t index = 0; index < 15; ++index) {
        const unsigned char byte = digest[index / 2];
        username.push_back(
            hex[index % 2 == 0 ? byte >> 4 : byte & 0x0f]);
    }
    return username;
}

void SetupSandboxIdentity(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid,
    SandboxIdentityKind kind) {
    RequireAdministrator();
    const auto username = SandboxUsernameForOwner(owner_sid, kind);
    static_cast<void>(RequireOwnedAccount(state_directory, owner_sid, kind));
    auto password = GeneratePassword();
    try {
        CreateOrResetAccount(username, password, owner_sid);
        auto [sid, sid_string] = LookupOfflineSid(username);
        static_cast<void>(sid_string);
        GrantLogonRights(sid.get());
        SavePassword(state_directory, owner_sid, kind, password);
        SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    } catch (...) {
        SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
        throw;
    }
}

void ResetSandboxIdentityCredentials(
    const std::filesystem::path& state_directory) {
    for (const auto kind : {SandboxIdentityKind::kOffline, SandboxIdentityKind::kOnline, SandboxIdentityKind::kProxy}) {
        const auto credential = CredentialPath(state_directory, kind);
        std::error_code error;
        std::filesystem::remove(credential, error);
        if (error) {
            throw std::runtime_error("failed to clear sandbox credential state");
        }
        error.clear();
        std::filesystem::remove(credential.wstring() + L".tmp", error);
        if (error) {
            throw std::runtime_error("failed to clear temporary sandbox credential state");
        }
    }
}

SandboxIdentity LoadSandboxIdentity(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid,
    SandboxIdentityKind kind) {
    const auto username = SandboxUsernameForOwner(owner_sid, kind);
    auto password = LoadPassword(state_directory, kind);
    HANDLE raw_token = nullptr;
    const BOOL logged_on = LogonUserW(
        username.c_str(),
        L".",
        password.c_str(),
        LOGON32_LOGON_BATCH,
        LOGON32_PROVIDER_DEFAULT,
        &raw_token);
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    if (logged_on == 0) throw Win32Error("LogonUserW(sandbox account)");
    UniqueHandle token{raw_token};
    auto [sid, sid_string] = LookupOfflineSid(username);
    if (SidStringFromToken(token.get()) != sid_string) {
        throw std::runtime_error("sandbox account token does not match its identity");
    }
    return SandboxIdentity{std::move(token), std::move(sid), std::move(sid_string)};
}

DWORD RunAsSandboxIdentity(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid,
    SandboxIdentityKind kind,
    const std::vector<std::wstring>& argv,
    const std::filesystem::path& cwd,
    unsigned short network_proxy_port) {
    const auto username = SandboxUsernameForOwner(owner_sid, kind);
    const auto [sid, sid_string] = LookupOfflineSid(username);
    auto password = LoadPassword(state_directory, kind);
    try {
        const DWORD exit_code = RunProcessWithLogonInJob(
            username, password, argv, cwd, sid_string, network_proxy_port);
        SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
        return exit_code;
    } catch (...) {
        SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
        throw;
    }
}

}  // namespace mycli::sandbox
