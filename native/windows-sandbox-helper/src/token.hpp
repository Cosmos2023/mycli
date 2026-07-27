#pragma once

#include "win32.hpp"
#include <vector>

namespace mycli::sandbox {

UniqueHandle CreateRestrictedPrimaryToken();
UniqueHandle CreateRestrictedPrimaryToken(const std::vector<PSID>& restricting_sids);

}  // namespace mycli::sandbox
