#include "sid.hpp"
#include <bcrypt.h>
#include <sddl.h>
#include <array>
#include <cstring>
#include <cwctype>
#include <sstream>
#include <vector>

namespace mycli::sandbox {
LocalSid DeriveCapabilitySid(
    const std::filesystem::path& root,
    const std::wstring& capability_scope) {
    auto normalized = capability_scope + L"\n" +
        std::filesystem::weakly_canonical(root).wstring();
    for (auto& ch : normalized) ch = static_cast<wchar_t>(std::towlower(ch));
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) {
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
    std::vector<UCHAR> hash_object(object_bytes);
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
            reinterpret_cast<PUCHAR>(normalized.data()),
            static_cast<ULONG>(normalized.size() * sizeof(wchar_t)),
            0);
    }
    if (status >= 0) {
        status = BCryptFinishHash(
            hash, digest.data(), static_cast<ULONG>(digest.size()), 0);
    }
    if (hash != nullptr) BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (status < 0) throw std::runtime_error("BCrypt SHA-256 failed");
    std::wostringstream text;
    text << L"S-1-5-21";
    for (std::size_t offset = 0; offset < 16; offset += 4) {
        DWORD value = 0;
        std::memcpy(&value, digest.data() + offset, sizeof(value));
        text << L'-' << (value | 0x10000000U);
    }
    PSID sid = nullptr;
    if (ConvertStringSidToSidW(text.str().c_str(), &sid) == 0) {
        throw Win32Error("ConvertStringSidToSidW");
    }
    return LocalSid{sid};
}

LocalSid SidFromString(const std::wstring& sid_string) {
    PSID sid = nullptr;
    if (ConvertStringSidToSidW(sid_string.c_str(), &sid) == 0) {
        throw Win32Error("ConvertStringSidToSidW");
    }
    return LocalSid{sid};
}
}  // namespace mycli::sandbox
