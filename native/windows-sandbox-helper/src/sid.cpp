#include "sid.hpp"
#include <bcrypt.h>
#include <sddl.h>
#include <array>
#include <cstring>
#include <cwctype>
#include <sstream>

namespace mycli::sandbox {
LocalSid DeriveCapabilitySid(const std::filesystem::path& root) {
    auto normalized = std::filesystem::weakly_canonical(root).wstring();
    for (auto& ch : normalized) ch = static_cast<wchar_t>(std::towlower(ch));
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) {
        throw std::runtime_error("BCryptOpenAlgorithmProvider failed");
    }
    std::array<unsigned char, 32> digest{};
    const auto status = BCryptHash(
        algorithm, nullptr, 0,
        reinterpret_cast<PUCHAR>(normalized.data()),
        static_cast<ULONG>(normalized.size() * sizeof(wchar_t)),
        digest.data(), static_cast<ULONG>(digest.size()));
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (status < 0) throw std::runtime_error("BCryptHash failed");
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
}  // namespace mycli::sandbox
