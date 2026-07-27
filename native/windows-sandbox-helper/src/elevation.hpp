#pragma once

#include <filesystem>
#include <string>

namespace mycli::sandbox {
int RunElevatedSetup(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid);
}
