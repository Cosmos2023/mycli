#pragma once

#include <windows.h>
#include <string>

namespace mycli::sandbox {

void SetupOfflineWfp(const std::wstring& offline_sid);
bool OfflineWfpReady(const std::wstring& offline_sid);
void SetupProxyWfp(const std::wstring& account_sid, const std::wstring& owner_sid);
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
