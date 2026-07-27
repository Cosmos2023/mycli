#pragma once
#include <windows.h>
#include <filesystem>
#include "win32.hpp"

namespace mycli::sandbox {
class LocalSid {
  public:
    explicit LocalSid(PSID sid) : sid_{sid} {}
    ~LocalSid() { if (sid_ != nullptr) LocalFree(sid_); }
    LocalSid(const LocalSid&) = delete;
    LocalSid& operator=(const LocalSid&) = delete;
    LocalSid(LocalSid&& other) noexcept : sid_{other.sid_} { other.sid_ = nullptr; }
    [[nodiscard]] PSID get() const noexcept { return sid_; }
  private:
    PSID sid_ = nullptr;
};
LocalSid DeriveCapabilitySid(
    const std::filesystem::path& root,
    const std::wstring& capability_scope);
}  // namespace mycli::sandbox
