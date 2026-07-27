#include "identity.hpp"

#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <dpapi.h>
#include <lm.h>
#include <ntsecapi.h>
#include <sddl.h>
#include <shlobj.h>

#include <array>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <utility>
#include <vector>

namespace mycli::sandbox {
namespace {

constexpr std::array<unsigned char, 16> kCredentialMagic{
    'M', 'Y', 'C', 'L', 'I', 'W', 'S', 'C', 'R', 'E', 'D', '0', '0', '0', '0', '1'};
constexpr wchar_t kCredentialDescription[] = L"mycli Windows sandbox offline credential";
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

std::filesystem::path CredentialPath(const std::filesystem::path& state_directory) {
    return state_directory / L"offline.credential";
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
    std::wstring path_text = path.wstring();
    const DWORD security_status = SetNamedSecurityInfoW(
        path_text.data(),
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
    std::array<std::wstring, 3> names{
        L"SeBatchLogonRight",
        L"SeDenyInteractiveLogonRight",
        L"SeDenyRemoteInteractiveLogonRight"};
    std::array<LSA_UNICODE_STRING, 3> rights{};
    for (std::size_t index = 0; index < names.size(); ++index) {
        rights[index].Buffer = names[index].data();
        rights[index].Length = static_cast<USHORT>(names[index].size() * sizeof(wchar_t));
        rights[index].MaximumLength = rights[index].Length;
    }
    status = LsaAddAccountRights(
        policy, sid, rights.data(), static_cast<ULONG>(rights.size()));
    LsaClose(policy);
    if (status != 0) {
        SetLastError(LsaNtStatusToWinError(status));
        throw Win32Error("LsaAddAccountRights");
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
    const std::wstring& password) {
    PrepareStateDirectory(state_directory, owner_sid);
    const auto target = CredentialPath(state_directory);
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

std::wstring LoadPassword(const std::filesystem::path& state_directory) {
    std::ifstream input{CredentialPath(state_directory), std::ios::binary};
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

void CreateOrResetAccount(
    const std::wstring& username,
    const std::wstring& password) {
    USER_INFO_1 user{};
    user.usri1_name = const_cast<LPWSTR>(username.c_str());
    user.usri1_password = const_cast<LPWSTR>(password.c_str());
    user.usri1_priv = USER_PRIV_USER;
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
    if (status != NERR_Success) {
        throw std::runtime_error(
            "failed to create sandbox account: NetAPI status " + std::to_string(status));
    }
}

}  // namespace

bool OfflineIdentityCredentialsExist(
    const std::filesystem::path& state_directory) {
    std::error_code error;
    return std::filesystem::is_regular_file(CredentialPath(state_directory), error);
}

std::filesystem::path SandboxStateDirectory() {
    return StateDirectory();
}

std::wstring CurrentUserSidString() {
    HANDLE raw_token = nullptr;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token) == 0) {
        throw Win32Error("OpenProcessToken(current user)");
    }
    const UniqueHandle token{raw_token};
    return SidStringFromToken(token.get());
}

std::wstring OfflineUsernameForOwner(const std::wstring& owner_sid) {
    static_cast<void>(SidFromString(owner_sid));
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(
            &algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) {
        throw std::runtime_error("BCryptOpenAlgorithmProvider failed");
    }
    DWORD object_bytes = 0;
    DWORD copied = 0;
    if (BCryptGetProperty(
            algorithm,
            BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&object_bytes),
            sizeof(object_bytes),
            &copied,
            0) < 0) {
        BCryptCloseAlgorithmProvider(algorithm, 0);
        throw std::runtime_error("BCryptGetProperty failed");
    }
    std::vector<unsigned char> hash_object(object_bytes);
    std::array<unsigned char, 32> digest{};
    BCRYPT_HASH_HANDLE hash = nullptr;
    auto status = BCryptCreateHash(
        algorithm,
        &hash,
        hash_object.data(),
        static_cast<ULONG>(hash_object.size()),
        nullptr,
        0,
        0);
    if (status >= 0) {
        status = BCryptHashData(
            hash,
            reinterpret_cast<PUCHAR>(const_cast<wchar_t*>(owner_sid.data())),
            static_cast<ULONG>(owner_sid.size() * sizeof(wchar_t)),
            0);
    }
    if (status >= 0) {
        status = BCryptFinishHash(
            hash, digest.data(), static_cast<ULONG>(digest.size()), 0);
    }
    if (hash != nullptr) BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (status < 0) throw std::runtime_error("BCrypt SHA-256 failed");
    constexpr wchar_t hex[] = L"0123456789abcdef";
    std::wstring username = L"mcli_";
    for (std::size_t index = 0; index < 15; ++index) {
        const unsigned char byte = digest[index / 2];
        username.push_back(
            hex[index % 2 == 0 ? byte >> 4 : byte & 0x0f]);
    }
    return username;
}

void SetupOfflineIdentity(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid) {
    RequireAdministrator();
    const auto username = OfflineUsernameForOwner(owner_sid);
    const auto password = GeneratePassword();
    CreateOrResetAccount(username, password);
    auto [sid, sid_string] = LookupOfflineSid(username);
    static_cast<void>(sid_string);
    GrantLogonRights(sid.get());
    SavePassword(state_directory, owner_sid, password);
}

OfflineIdentity LoadOfflineIdentity(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid) {
    const auto username = OfflineUsernameForOwner(owner_sid);
    auto password = LoadPassword(state_directory);
    HANDLE raw_token = nullptr;
    const BOOL logged_on = LogonUserW(
        username.c_str(),
        L".",
        password.c_str(),
        LOGON32_LOGON_BATCH,
        LOGON32_PROVIDER_DEFAULT,
        &raw_token);
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    if (logged_on == 0) throw Win32Error("LogonUserW(offline sandbox account)");
    auto [sid, sid_string] = LookupOfflineSid(username);
    return OfflineIdentity{UniqueHandle{raw_token}, std::move(sid), std::move(sid_string)};
}

}  // namespace mycli::sandbox
