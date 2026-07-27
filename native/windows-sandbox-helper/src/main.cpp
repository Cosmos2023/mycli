#include <algorithm>
#include <exception>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>

#include "protocol.hpp"
#include "sandbox.hpp"
#include "firewall.hpp"
#include "elevation.hpp"
#include "identity.hpp"

namespace {

constexpr wchar_t kHelperName[] = L"mycli-windows-sandbox";
constexpr bool kEnforcementReleased = false;

bool SetupComplete() {
    if (!mycli::sandbox::OfflineIdentityCredentialsExist()) return false;
    try {
        const auto identity = mycli::sandbox::LoadOfflineIdentity();
        return mycli::sandbox::OfflineFirewallSetupReady(identity.sid_string);
    } catch (const std::exception&) {
        return false;
    }
}

int Run(int argc, wchar_t* argv[]) {
    if (argc == 2 && std::wstring_view{argv[1]} == L"--handshake") {
        const bool setup_complete = SetupComplete();
        std::wcout << L"{\"name\":\"" << kHelperName
                   << L"\",\"protocol_version\":"
                   << mycli::sandbox::kProtocolVersion
                   << L",\"setup_complete\":"
                   << (setup_complete ? L"true" : L"false")
                   << L",\"sandbox_ready\":"
                   << (setup_complete && kEnforcementReleased ? L"true" : L"false")
                   << L"}\n";
        return 0;
    }
    if (argc == 2 && std::wstring_view{argv[1]} == L"--setup") {
        mycli::sandbox::SetupOfflineIdentity();
        const auto identity = mycli::sandbox::LoadOfflineIdentity();
        mycli::sandbox::SetupOfflineFirewall(identity.sid_string);
        std::wcout << L"Windows sandbox setup completed\n";
        return 0;
    }
    if (argc == 2 && std::wstring_view{argv[1]} == L"--ensure-setup") {
        if (SetupComplete()) return 0;
        return mycli::sandbox::RunElevatedSetup();
    }
    if (argc == 3 && std::wstring_view{argv[1]} == L"--request-json") {
        if (!SetupComplete()) {
            throw std::runtime_error("Windows sandbox setup is incomplete; run --setup elevated");
        }
        const auto request = mycli::sandbox::ParseAndValidateRequest(argv[2]);
        const auto identity = mycli::sandbox::LoadOfflineIdentity();
        return static_cast<int>(mycli::sandbox::RunSandboxRequest(
            request, identity.token.get(), identity.sid.get()));
    }
    throw std::runtime_error(
        "expected --handshake, --setup, --ensure-setup, or --request-json <json>");
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
    try {
        return std::clamp(Run(argc, argv), 0, 255);
    } catch (const std::exception& error) {
        std::cerr << "mycli Windows sandbox error: " << error.what() << '\n';
    }
    return 1;
}
