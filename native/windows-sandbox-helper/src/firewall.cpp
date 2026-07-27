#include "firewall.hpp"

#include <windows.h>

#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "process.hpp"
#include "win32.hpp"

namespace mycli::sandbox {
namespace {

constexpr wchar_t kRuleNamePrefix[] = L"mycli_sandbox_offline_block_outbound_";

std::filesystem::path MarkerPath(const std::filesystem::path& state_directory) {
    return state_directory / L"firewall.v1";
}

std::filesystem::path PowerShellPath() {
    std::vector<wchar_t> windows_directory(MAX_PATH);
    const UINT chars = GetWindowsDirectoryW(
        windows_directory.data(), static_cast<UINT>(windows_directory.size()));
    if (chars == 0 || chars >= windows_directory.size()) {
        throw Win32Error("GetWindowsDirectoryW");
    }
    return std::filesystem::path{windows_directory.data()} /
        L"System32" / L"WindowsPowerShell" / L"v1.0" / L"powershell.exe";
}

std::wstring Base64Utf16(const std::wstring& value) {
    static constexpr wchar_t alphabet[] =
        L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const auto* input = reinterpret_cast<const unsigned char*>(value.data());
    const std::size_t bytes = value.size() * sizeof(wchar_t);
    std::wstring output;
    output.reserve(((bytes + 2) / 3) * 4);
    for (std::size_t offset = 0; offset < bytes; offset += 3) {
        const unsigned value0 = input[offset];
        const unsigned value1 = offset + 1 < bytes ? input[offset + 1] : 0;
        const unsigned value2 = offset + 2 < bytes ? input[offset + 2] : 0;
        const unsigned combined = (value0 << 16) | (value1 << 8) | value2;
        output.push_back(alphabet[(combined >> 18) & 0x3f]);
        output.push_back(alphabet[(combined >> 12) & 0x3f]);
        output.push_back(offset + 1 < bytes ? alphabet[(combined >> 6) & 0x3f] : L'=');
        output.push_back(offset + 2 < bytes ? alphabet[combined & 0x3f] : L'=');
    }
    return output;
}

void ValidateSidString(const std::wstring& sid) {
    if (!sid.starts_with(L"S-1-5-") ||
        sid.find_first_not_of(L"S-0123456789-") != std::wstring::npos) {
        throw std::runtime_error("offline account SID has an invalid format");
    }
}

std::wstring RuleName(const std::wstring& offline_sid) {
    ValidateSidString(offline_sid);
    return std::wstring{kRuleNamePrefix} + offline_sid;
}

}  // namespace

void SetupOfflineFirewall(
    const std::wstring& offline_sid,
    const std::filesystem::path& state_directory) {
    const auto rule_name = RuleName(offline_sid);
    const std::wstring script =
        L"$ErrorActionPreference='Stop';" 
        L"$name='" + rule_name + L"';"
        L"$sddl='O:LSD:(A;;CC;;;" + offline_sid + L")';" 
        L"Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue | "
        L"Remove-NetFirewallRule -ErrorAction Stop;"
        L"New-NetFirewallRule -Name $name -DisplayName 'mycli Sandbox Offline' "
        L"-Direction Outbound -Action Block -Enabled True -Profile Any "
        L"-Protocol Any -LocalUser $sddl | Out-Null;"
        L"$rule=Get-NetFirewallRule -Name $name -ErrorAction Stop;"
        L"if($rule.Direction -ne 'Outbound' -or $rule.Action -ne 'Block' -or "
        L"$rule.Enabled -ne 'True' -or $rule.LocalUserAuthorizedList -notmatch '" +
        offline_sid + L"'){exit 23}";
    const auto powershell = PowerShellPath();
    const DWORD exit_code = RunHostProcessInJob(
        {powershell.wstring(), L"-NoLogo", L"-NoProfile", L"-NonInteractive",
         L"-ExecutionPolicy", L"Bypass", L"-EncodedCommand", Base64Utf16(script)},
        state_directory);
    if (exit_code != 0) {
        throw std::runtime_error(
            "failed to install offline firewall rule; PowerShell exit code " +
            std::to_string(exit_code));
    }
    std::filesystem::create_directories(state_directory);
    std::ofstream marker{MarkerPath(state_directory), std::ios::binary | std::ios::trunc};
    const std::string sid_ascii(offline_sid.begin(), offline_sid.end());
    marker << sid_ascii << '\n';
    marker.close();
    if (!marker) throw std::runtime_error("failed to persist firewall setup marker");
}

bool OfflineFirewallSetupReady(
    const std::wstring& offline_sid,
    const std::filesystem::path& state_directory) {
    std::ifstream marker{MarkerPath(state_directory), std::ios::binary};
    std::string stored;
    std::getline(marker, stored);
    return marker.good() || marker.eof()
        ? stored == std::string(offline_sid.begin(), offline_sid.end())
        : false;
}

}  // namespace mycli::sandbox
