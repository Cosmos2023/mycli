#pragma once

#include <windows.h>
#include <string>

namespace mycli::sandbox {

// Owns an isolated desktop until the complete sandbox process tree has exited.
class PrivateDesktop {
  public:
    explicit PrivateDesktop(PSID account_sid);
    ~PrivateDesktop();
    void AllowLogon(HANDLE process) const;
    PrivateDesktop(const PrivateDesktop&) = delete;
    PrivateDesktop& operator=(const PrivateDesktop&) = delete;
    [[nodiscard]] const std::wstring& name() const noexcept { return name_; }
  private:
    HDESK handle_ = nullptr;
    std::wstring name_;
};

std::wstring CurrentDesktopName();

}  // namespace mycli::sandbox
