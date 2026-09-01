#pragma once

#include <filesystem>
#include <stdexcept>
#include <string>

namespace mycli::sandbox {

inline constexpr int kElevationCanceledExitCode = 2;

class ElevationCanceled final : public std::runtime_error {
  public:
    ElevationCanceled() : std::runtime_error{"Windows sandbox elevation was canceled"} {}
};

int RunElevatedSetup(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid);
}
