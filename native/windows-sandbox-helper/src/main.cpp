#include <algorithm>
#include <exception>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "acl.hpp"
#include "protocol.hpp"
#include "sandbox.hpp"
#include "firewall.hpp"
#include "elevation.hpp"
#include "identity.hpp"
#include "win32.hpp"

namespace {

constexpr wchar_t kHelperName[] = L"mycli-windows-sandbox";
constexpr bool kEnforcementReleased = false;

class SetupStateLock {
  public:
    explicit SetupStateLock(const std::wstring& owner_sid)
        : handle_{CreateMutexW(
              nullptr,
              FALSE,
              (L"Local\\mycli-windows-sandbox-setup-" + owner_sid).c_str())} {
        if (!handle_) throw mycli::sandbox::Win32Error("CreateMutexW(sandbox setup)");
        const DWORD wait_result = WaitForSingleObject(handle_.get(), INFINITE);
        if (wait_result != WAIT_OBJECT_0 && wait_result != WAIT_ABANDONED) {
            throw mycli::sandbox::Win32Error("WaitForSingleObject(sandbox setup)");
        }
        owns_mutex_ = true;
    }

    ~SetupStateLock() {
        if (owns_mutex_) ReleaseMutex(handle_.get());
    }

    SetupStateLock(const SetupStateLock&) = delete;
    SetupStateLock& operator=(const SetupStateLock&) = delete;

  private:
    mycli::sandbox::UniqueHandle handle_;
    bool owns_mutex_ = false;
};

std::filesystem::path CurrentExecutablePath() {
    std::vector<wchar_t> path(32768);
    const DWORD chars = GetModuleFileNameW(
        nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (chars == 0 || chars >= path.size()) {
        throw std::runtime_error("failed to resolve Windows sandbox helper path");
    }
    return std::filesystem::path{std::wstring{path.data(), chars}};
}

bool SetupComplete() {
    const auto state_directory = mycli::sandbox::SandboxStateDirectory();
    const auto owner_sid = mycli::sandbox::CurrentUserSidString();
    if (!mycli::sandbox::OfflineIdentityCredentialsExist(state_directory)) return false;
    try {
        const auto identity = mycli::sandbox::LoadOfflineIdentity(
            state_directory, owner_sid);
        return mycli::sandbox::OfflineFirewallSetupReady(
            identity.sid_string, state_directory);
    } catch (const std::exception&) {
        return false;
    }
}

void SetupForUser(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid) {
    std::cerr << "setup: identity-start\n" << std::flush;
    mycli::sandbox::SetupOfflineIdentity(state_directory, owner_sid);
    std::cerr << "setup: identity-done\n" << std::flush;
    const auto identity = mycli::sandbox::LoadOfflineIdentity(
        state_directory, owner_sid);
    std::cerr << "setup: firewall-start\n" << std::flush;
    mycli::sandbox::SetupOfflineFirewall(identity.sid_string, state_directory);
    std::cerr << "setup: firewall-done\n" << std::flush;
}

void EnsureSetupComplete() {
    const auto owner_sid = mycli::sandbox::CurrentUserSidString();
    const SetupStateLock setup_lock{owner_sid};
    static_cast<void>(setup_lock);
    if (SetupComplete()) return;

    const int exit_code = mycli::sandbox::RunElevatedSetup(
        mycli::sandbox::SandboxStateDirectory(),
        owner_sid);
    if (exit_code != 0) {
        throw std::runtime_error("Windows sandbox setup failed");
    }
    if (!SetupComplete()) {
        throw std::runtime_error(
            "Windows sandbox setup exited before setup completed");
    }
}

void ResetSetupState() {
    const auto owner_sid = mycli::sandbox::CurrentUserSidString();
    const SetupStateLock setup_lock{owner_sid};
    static_cast<void>(setup_lock);
    const auto state_directory = mycli::sandbox::SandboxStateDirectory();
    mycli::sandbox::ResetOfflineIdentityCredentials(state_directory);
    mycli::sandbox::ResetOfflineFirewallState(state_directory);
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
        SetupForUser(
            mycli::sandbox::SandboxStateDirectory(),
            mycli::sandbox::CurrentUserSidString());
        std::wcout << L"Windows sandbox setup completed\n";
        return 0;
    }
    if (argc == 4 && std::wstring_view{argv[1]} == L"--setup-for-user") {
        SetupForUser(std::filesystem::path{argv[2]}, argv[3]);
        std::wcout << L"Windows sandbox setup completed\n";
        return 0;
    }
    if (argc == 2 && std::wstring_view{argv[1]} == L"--ensure-setup") {
        EnsureSetupComplete();
        return 0;
    }
    if (argc == 2 && std::wstring_view{argv[1]} == L"--reset") {
        ResetSetupState();
        std::wcout << L"Windows sandbox setup state reset\n";
        return 0;
    }
    if (argc == 4 && std::wstring_view{argv[1]} == L"--run-prepared-json") {
        if (mycli::sandbox::CurrentUserSidString() != argv[3]) {
            throw std::runtime_error("sandbox runner identity mismatch");
        }
        return static_cast<int>(mycli::sandbox::RunPreparedSandboxRequest(
            mycli::sandbox::ParseAndValidateRequest(argv[2])));
    }
    if (argc == 3 && std::wstring_view{argv[1]} == L"--request-json") {
        const auto request = mycli::sandbox::ParseAndValidateRequest(argv[2]);
        EnsureSetupComplete();
        const auto state_directory = mycli::sandbox::SandboxStateDirectory();
        const auto owner_sid = mycli::sandbox::CurrentUserSidString();
        const auto identity = mycli::sandbox::LoadOfflineIdentity(
            state_directory, owner_sid);
        mycli::sandbox::PrepareSandboxRequest(request, identity.sid.get());
        const auto helper = CurrentExecutablePath();
        const auto helper_root = helper.parent_path().has_parent_path()
            ? helper.parent_path().parent_path()
            : helper.parent_path();
        mycli::sandbox::GrantReadableRoot(helper_root, identity.sid.get());
        return static_cast<int>(mycli::sandbox::RunAsOfflineIdentity(
            state_directory,
            owner_sid,
            {helper.wstring(), L"--run-prepared-json", argv[2], identity.sid_string},
            std::filesystem::path{request.cwd}));
    }
    throw std::runtime_error(
        "expected --handshake, --setup, --setup-for-user, --ensure-setup, "
        "--reset, or --request-json <json>");
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
    try {
        return std::clamp(Run(argc, argv), 0, 255);
    } catch (const mycli::sandbox::ElevationCanceled&) {
        return mycli::sandbox::kElevationCanceledExitCode;
    } catch (const std::exception& error) {
        std::cerr << "mycli Windows sandbox error: " << error.what() << '\n';
    }
    return 1;
}
