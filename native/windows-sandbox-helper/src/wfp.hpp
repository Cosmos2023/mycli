#pragma once

#include <windows.h>
#include <filesystem>
#include <string>

namespace mycli::sandbox {

void RemoveSandboxWfp(const std::wstring& account_sid);
void SetupOfflineWfp(const std::wstring& offline_sid);
bool OfflineWfpReady(const std::wstring& offline_sid);
void SetupProxyWfp(const std::wstring& account_sid, const std::wstring& owner_sid, const std::filesystem::path& state_directory);
void RestoreSandboxWfpAccess(const std::wstring& owner_sid, const std::filesystem::path& state_directory);
bool ProxyWfpReady(const std::wstring& account_sid, const std::wstring& owner_sid);

// A dynamic WFP session permits only this logon's TCP connection to its proxy.
// Closing the session (including host termination) revokes the exception.
class NetworkProxySession {
  public:
    NetworkProxySession(HANDLE process, const std::wstring& account_sid, unsigned short port);
    ~NetworkProxySession();
    NetworkProxySession(const NetworkProxySession&) = delete;
    NetworkProxySession& operator=(const NetworkProxySession&) = delete;
  private:
    HANDLE engine_ = nullptr;
};

}  // namespace mycli::sandbox
