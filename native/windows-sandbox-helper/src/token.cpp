#include "token.hpp"

#include <windows.h>

#include <stdexcept>

namespace mycli::sandbox {

UniqueHandle CreateRestrictedPrimaryToken(const std::vector<PSID>& restricting_sids) {
    HANDLE raw_process_token = nullptr;
    constexpr DWORD kTokenAccess =
        TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY |
        TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID;
    if (OpenProcessToken(GetCurrentProcess(), kTokenAccess, &raw_process_token) == 0) {
        throw Win32Error("OpenProcessToken");
    }
    const UniqueHandle process_token{raw_process_token};

    return CreateRestrictedPrimaryTokenFrom(process_token.get(), restricting_sids);
}

UniqueHandle CreateRestrictedPrimaryTokenFrom(
    HANDLE base_token,
    const std::vector<PSID>& restricting_sids) {
    if (restricting_sids.empty()) {
        throw std::invalid_argument("restricted token requires at least one restricting SID");
    }
    HANDLE raw_restricted_token = nullptr;
    std::vector<SID_AND_ATTRIBUTES> entries;
    entries.reserve(restricting_sids.size());
    for (const auto sid : restricting_sids) {
        entries.push_back(SID_AND_ATTRIBUTES{sid, 0});
    }
    constexpr DWORD flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
    if (CreateRestrictedToken(
            base_token,
            flags,
            0,
            nullptr,
            0,
            nullptr,
            static_cast<DWORD>(entries.size()),
            entries.data(),
            &raw_restricted_token) == 0) {
        throw Win32Error("CreateRestrictedToken");
    }
    return UniqueHandle{raw_restricted_token};
}

}  // namespace mycli::sandbox
