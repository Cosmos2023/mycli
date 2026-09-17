#pragma once

#include "win32.hpp"
#include <vector>

namespace mycli::sandbox {

UniqueHandle CreateRestrictedPrimaryToken(const std::vector<PSID>& restricting_sids);
UniqueHandle CreateRestrictedPrimaryTokenFrom(
    HANDLE base_token,
    const std::vector<PSID>& restricting_sids);
std::vector<unsigned char> CopyTokenLogonSid(HANDLE token);

}  // namespace mycli::sandbox
