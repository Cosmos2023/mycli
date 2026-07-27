#pragma once

#include <string>

namespace mycli::sandbox {

void SetupOfflineWfp(const std::wstring& offline_sid);
bool OfflineWfpReady(const std::wstring& offline_sid);

}  // namespace mycli::sandbox
