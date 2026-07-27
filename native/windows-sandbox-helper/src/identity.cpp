#include "identity.hpp"

#include <windows.h>
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

std::filesystem::path CredentialPath() {
    return SandboxStateDirectory() / L"offline.credential";
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

std::pair<LocalSid, std::wstring> LookupOfflineSid() {
    DWORD sid_bytes = 0;
    DWORD domain_chars = 0;
    SID_NAME_USE sid_type{};
    LookupAccountNameW(
        nullptr, kOfflineUsername, nullptr, &sid_bytes, nullptr, &domain_chars, &sid_type);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        throw Win32Error("LookupAccountNameW(size)");
    }
    std::vector<unsigned char> sid_storage(sid_bytes);
    std::vector<wchar_t> domain(domain_chars);
    if (LookupAccountNameW(
            nullptr,
            kOfflineUsername,
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
            CRYPTPROTECT_UI_FORBIDDEN,
            &output) == 0) {
        throw Win32Error("CryptProtectData");
    }
    std::vector<unsigned char> protected_data(output.pbData, output.pbData + output.cbData);
    LocalFree(output.pbData);
    return protected_data;
}

void SavePassword(const std::wstring& password) {
    const auto directory = StateDirectory();
    std::filesystem::create_directories(directory);
    const auto target = CredentialPath();
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
}

std::wstring LoadPassword() {
    std::ifstream input{CredentialPath(), std::ios::binary};
    const std::vector<unsigned char> data{
        std::istreambuf_iterator<char>{input}, std::istreambuf_iterator<char>{}};
    if (!input.eof() || data.size() <= kCredentialMagic.size() ||
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

void CreateOrResetAccount(const std::wstring& password) {
    USER_INFO_1 user{};
    user.usri1_name = const_cast<LPWSTR>(kOfflineUsername);
    user.usri1_password = const_cast<LPWSTR>(password.c_str());
    user.usri1_priv = USER_PRIV_USER;
    user.usri1_flags = UF_SCRIPT | UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE;
    DWORD parameter_error = 0;
    NET_API_STATUS status = NetUserAdd(nullptr, 1, reinterpret_cast<LPBYTE>(&user), &parameter_error);
    if (status == NERR_UserExists) {
        USER_INFO_1003 password_info{const_cast<LPWSTR>(password.c_str())};
        status = NetUserSetInfo(
            nullptr,
            kOfflineUsername,
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

bool OfflineIdentityCredentialsExist() {
    std::error_code error;
    return std::filesystem::is_regular_file(CredentialPath(), error);
}

std::filesystem::path SandboxStateDirectory() {
    return StateDirectory();
}

void SetupOfflineIdentity() {
    RequireAdministrator();
    const auto password = GeneratePassword();
    CreateOrResetAccount(password);
    auto [sid, sid_string] = LookupOfflineSid();
    static_cast<void>(sid_string);
    GrantLogonRights(sid.get());
    SavePassword(password);
}

OfflineIdentity LoadOfflineIdentity() {
    auto password = LoadPassword();
    HANDLE raw_token = nullptr;
    const BOOL logged_on = LogonUserW(
        kOfflineUsername,
        L".",
        password.c_str(),
        LOGON32_LOGON_BATCH,
        LOGON32_PROVIDER_DEFAULT,
        &raw_token);
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    if (logged_on == 0) throw Win32Error("LogonUserW(offline sandbox account)");
    auto [sid, sid_string] = LookupOfflineSid();
    return OfflineIdentity{UniqueHandle{raw_token}, std::move(sid), std::move(sid_string)};
}

}  // namespace mycli::sandbox
