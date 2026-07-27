#pragma once
#include <string>
namespace mycli::sandbox {
void SetupOfflineFirewall(const std::wstring& offline_sid);
bool OfflineFirewallSetupReady(const std::wstring& offline_sid);
}
