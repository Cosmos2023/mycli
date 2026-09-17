#pragma once

#include <filesystem>
#include <string>
namespace mycli::sandbox {
void SetupOfflineFirewall(
    const std::wstring& offline_sid,
    const std::filesystem::path& state_directory);
void RemoveSandboxFirewall(const std::wstring& sid);
void ResetOfflineFirewallState(
    const std::filesystem::path& state_directory);
bool OfflineFirewallSetupReady(
    const std::wstring& offline_sid,
    const std::filesystem::path& state_directory);
}
