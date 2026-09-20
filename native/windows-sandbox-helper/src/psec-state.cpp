#include "psec-state.hpp"

#include <array>
#include <string_view>

#include "identity.hpp"
#include "path-guard.hpp"
#include "psec.hpp"

namespace mycli::sandbox {
namespace {
constexpr std::string_view kMarker = "mycli-psec-v1\n";
}

bool PsecSetupPresent() {
    const auto path = SandboxStateDirectory() / L"psec.v1";
    std::error_code error;
    if (!std::filesystem::exists(path, error)) {
        if (error) throw std::runtime_error("psec_state_unreadable");
        return false;
    }
    const PathGuard guard{path};
    std::array<char, 64> contents{};
    DWORD read = 0;
    if (ReadFile(guard.leaf(), contents.data(), static_cast<DWORD>(contents.size()), &read, nullptr) == 0 ||
        std::string_view{contents.data(), read} != kMarker) {
        throw std::runtime_error("psec_state_invalid");
    }
    return true;
}

void SetupPsec() {
    if (!PsecAvailable()) throw std::runtime_error("psec_enforcement_unavailable");
    if (PsecSetupPresent()) return;
    const auto directory = SandboxStateDirectory();
    PrepareSandboxStateDirectory(directory, CurrentUserSidString());
    const PathGuard parent{directory};
    const UniqueHandle marker{CreateFileW((directory / L"psec.v1").c_str(), GENERIC_WRITE,
        0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
    if (!marker) throw Win32Error("create PSEC state");
    DWORD written = 0;
    if (WriteFile(marker.get(), kMarker.data(), static_cast<DWORD>(kMarker.size()), &written, nullptr) == 0 ||
        written != kMarker.size() || FlushFileBuffers(marker.get()) == 0) {
        throw Win32Error("persist PSEC state");
    }
}

void ResetPsec() {
    const auto directory = SandboxStateDirectory();
    if (!std::filesystem::exists(directory)) return;
    const PathGuard parent{directory};
    if (DeleteFileW((directory / L"psec.v1").c_str()) == 0 && GetLastError() != ERROR_FILE_NOT_FOUND) {
        throw Win32Error("remove PSEC state");
    }
}

}  // namespace mycli::sandbox
