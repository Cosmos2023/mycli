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
    LocalSid& operator=(LocalSid&& other) noexcept {
        if (this != &other) {
            if (sid_ != nullptr) LocalFree(sid_);
            sid_ = other.sid_;
            other.sid_ = nullptr;
        }
        return *this;
    }
    [[nodiscard]] PSID get() const noexcept { return sid_; }
  private:
    PSID sid_ = nullptr;
};
LocalSid DeriveCapabilitySid(
    const std::filesystem::path& root,
    const std::wstring& capability_scope);
LocalSid SidFromString(const std::wstring& sid_string);
}  // namespace mycli::sandbox
