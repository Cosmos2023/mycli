#pragma once

#include <windows.h>

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "protocol.hpp"

namespace mycli::sandbox {

inline constexpr DWORD_PTR kSecurityEnvironmentAttribute = 0x00020023;

struct PsecPolicy {
    std::vector<std::wstring> read_roots;
    std::vector<std::wstring> write_roots;
    std::vector<std::wstring> denied_roots;
    std::vector<std::wstring> protected_roots;
    bool network_enabled = false;
    unsigned short proxy_port = 0;
    bool allow_local_binding = false;
    bool unrestricted_filesystem = false;
    std::wstring temporary_directory;
    std::optional<NetworkEgressPolicy> network_egress;
};

std::vector<std::uint8_t> BuildPsecSpecification(const PsecPolicy& policy);

class PsecEnvironment {
  public:
    explicit PsecEnvironment(std::span<const std::uint8_t> specification);
    ~PsecEnvironment();
    PsecEnvironment(const PsecEnvironment&) = delete;
    PsecEnvironment& operator=(const PsecEnvironment&) = delete;
    [[nodiscard]] HANDLE get() const noexcept { return handle_; }
  private:
    HANDLE handle_ = nullptr;
};

// Includes native environment creation and startup-attribute support.
bool PsecAvailable() noexcept;

}  // namespace mycli::sandbox
