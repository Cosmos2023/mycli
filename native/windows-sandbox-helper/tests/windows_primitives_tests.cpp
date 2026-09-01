#include <windows.h>
#include <aclapi.h>

#include <exception>
#include <filesystem>
#include <iostream>
#include <fstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "acl.hpp"
#include "firewall.hpp"
#include "identity.hpp"
#include "process.hpp"
#include "sandbox.hpp"
#include "sid.hpp"
#include "token.hpp"

namespace {

class SavedDacl {
  public:
    explicit SavedDacl(std::filesystem::path path) : path_{std::move(path)} {
        const DWORD status = GetNamedSecurityInfoW(
            path_.native().data(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            nullptr,
            nullptr,
            &dacl_,
            nullptr,
            &descriptor_);
        if (status != ERROR_SUCCESS) {
            throw std::runtime_error("failed to save test path DACL");
        }
    }

    ~SavedDacl() {
        Restore();
        if (descriptor_ != nullptr) LocalFree(descriptor_);
    }

    SavedDacl(const SavedDacl&) = delete;
    SavedDacl& operator=(const SavedDacl&) = delete;

    void Restore() noexcept {
        if (restored_) return;
        restored_ = true;
        static_cast<void>(SetNamedSecurityInfoW(
            const_cast<LPWSTR>(path_.c_str()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            nullptr,
            nullptr,
            dacl_,
            nullptr));
    }

  private:
    std::filesystem::path path_;
    PSECURITY_DESCRIPTOR descriptor_ = nullptr;
    PACL dacl_ = nullptr;
    bool restored_ = false;
};

int RunTests(const std::filesystem::path& executable) {
    const auto stage = [](const char* name) {
        std::cerr << "stage: " << name << '\n' << std::flush;
    };
    using mycli::sandbox::QuoteWindowsArgument;
    stage("argument-quoting");
    if (QuoteWindowsArgument(L"plain") != L"plain" ||
        QuoteWindowsArgument(L"") != L"\"\"" ||
        QuoteWindowsArgument(L"two words") != L"\"two words\"" ||
        QuoteWindowsArgument(L"a\"b") != L"\"a\\\"b\"" ||
        QuoteWindowsArgument(L"C:\\Program Files\\") !=
            L"\"C:\\Program Files\\\\\"") {
        std::cerr << "Windows argument quoting failed\n";
        return 1;
    }

    const auto owner_a = mycli::sandbox::OfflineUsernameForOwner(
        L"S-1-5-21-1-2-3-1001");
    const auto owner_b = mycli::sandbox::OfflineUsernameForOwner(
        L"S-1-5-21-1-2-3-1002");
    if (owner_a != mycli::sandbox::OfflineUsernameForOwner(
                       L"S-1-5-21-1-2-3-1001") ||
        owner_a == owner_b || owner_a.size() != 20 || !owner_a.starts_with(L"mcli_")) {
        std::cerr << "offline account derivation failed\n";
        return 1;
    }

    const std::vector<std::wstring> command{
        L"cmd.exe", L"/d", L"/s", L"/c", L"exit 7"};

    bool empty_restrictions_rejected = false;
    try {
        static_cast<void>(mycli::sandbox::CreateRestrictedPrimaryToken({}));
    } catch (const std::invalid_argument&) {
        empty_restrictions_rejected = true;
    }
    if (!empty_restrictions_rejected) {
        std::cerr << "empty restricting SID list did not fail closed\n";
        return 1;
    }

    stage("capability-acls");
    const auto test_root = std::filesystem::temp_directory_path() /
        (L"mycli-sandbox-" + std::to_wstring(GetCurrentProcessId()));
    const auto allowed = test_root / L"allowed";
    const auto denied = test_root / L"denied";
    std::filesystem::create_directories(allowed);
    std::filesystem::create_directories(denied);
    std::filesystem::create_directories(allowed / L".git");

    stage("setup-state-reset");
    const auto setup_state = test_root / L"state";
    std::filesystem::create_directories(setup_state);
    {
        std::ofstream credential{setup_state / L"offline.credential"};
        std::ofstream temporary{setup_state / L"offline.credential.tmp"};
        std::ofstream firewall_marker{setup_state / L"firewall.v1"};
        credential << "credential";
        temporary << "temporary";
        firewall_marker << "marker";
    }
    mycli::sandbox::ResetOfflineIdentityCredentials(setup_state);
    mycli::sandbox::ResetOfflineFirewallState(setup_state);
    mycli::sandbox::ResetOfflineIdentityCredentials(setup_state);
    mycli::sandbox::ResetOfflineFirewallState(setup_state);
    if (std::filesystem::exists(setup_state / L"offline.credential") ||
        std::filesystem::exists(setup_state / L"offline.credential.tmp") ||
        std::filesystem::exists(setup_state / L"firewall.v1")) {
        std::cerr << "sandbox setup state reset failed\n";
        return 1;
    }

    {
        std::ofstream secret{allowed / L".env"};
        secret << "secret";
    }
    SavedDacl allowed_secret_dacl{allowed / L".env"};
    const auto capability = mycli::sandbox::DeriveCapabilitySid(
        allowed, L"workspace-write");
    const auto read_only_capability = mycli::sandbox::DeriveCapabilitySid(
        allowed, L"read-only");
    auto account_sid = mycli::sandbox::SidFromString(
        mycli::sandbox::CurrentUserSidString());
    if (EqualSid(capability.get(), read_only_capability.get()) != 0) {
        std::cerr << "read-only and workspace-write capability SIDs collided\n";
        return 1;
    }
    mycli::sandbox::GrantWritableRoot(allowed, capability.get());
    mycli::sandbox::DenyReadPath(allowed / L".env", capability.get());
    mycli::sandbox::DenyReadPath(allowed / L".env", account_sid.get());
    mycli::sandbox::DenyWritePath(allowed / L".git", capability.get());
    const auto write_token = mycli::sandbox::CreateRestrictedPrimaryToken(
        {capability.get()});
    if (IsTokenRestricted(write_token.get()) == 0) {
        std::cerr << "capability token is not restricted\n";
        return 1;
    }
    stage("restricted-command");
    const auto exit_code = mycli::sandbox::RunProcessInJob(
        write_token.get(), command, std::filesystem::current_path());
    if (exit_code != 7) {
        std::cerr << "restricted child returned an unexpected exit code\n";
        return 1;
    }
    stage("job-tree-kill");
    const auto delayed_marker = allowed / L"delayed.txt";
    const auto tree_exit = mycli::sandbox::RunProcessInJob(
        write_token.get(),
        {executable.wstring(), L"--spawn-delayed-write", delayed_marker.wstring()},
        allowed);
    if (tree_exit != 0) {
        std::cerr << "job tree parent returned an unexpected exit code\n";
        return 1;
    }
    Sleep(1200);
    if (std::filesystem::exists(delayed_marker)) {
        std::cerr << "kill-on-close job leaked a descendant process\n";
        return 1;
    }
    stage("allowed-write");
    const auto allowed_exit = mycli::sandbox::RunProcessInJob(
        write_token.get(),
        {executable.wstring(), L"--write-file", (allowed / L"ok.txt").wstring()},
        allowed);
    stage("outside-write");
    const auto denied_exit = mycli::sandbox::RunProcessInJob(
        write_token.get(),
        {executable.wstring(), L"--write-file", (denied / L"blocked.txt").wstring()},
        denied);
    stage("secret-read");
    const auto secret_read_exit = mycli::sandbox::RunProcessInJob(
        write_token.get(),
        {executable.wstring(), L"--read-file", (allowed / L".env").wstring()},
        allowed);
    stage("metadata-write");
    const auto metadata_write_exit = mycli::sandbox::RunProcessInJob(
        write_token.get(),
        {executable.wstring(), L"--write-file", (allowed / L".git" / L"config").wstring()},
        allowed);
    std::cerr << "boundary exits: allowed=" << allowed_exit
              << " outside=" << denied_exit
              << " secret=" << secret_read_exit
              << " metadata=" << metadata_write_exit << '\n' << std::flush;
    if (allowed_exit != 0 || denied_exit == 0 ||
        secret_read_exit == 0 || metadata_write_exit == 0 ||
        !std::filesystem::exists(allowed / L"ok.txt") ||
        std::filesystem::exists(denied / L"blocked.txt") ||
        std::filesystem::exists(allowed / L".git" / L"config")) {
        std::cerr << "capability ACL write boundary failed\n";
        return 1;
    }

    stage("request-level-policy");
    const auto policy_allowed = test_root / L"policy-allowed";
    std::filesystem::create_directories(policy_allowed);
    {
        std::ofstream secret{policy_allowed / L".env"};
        secret << "secret";
    }
    SavedDacl policy_secret_dacl{policy_allowed / L".env"};
    const mycli::sandbox::SandboxRequest policy_request{
        .protocol_version = mycli::sandbox::kProtocolVersion,
        .command_argv = {
            executable.wstring(),
            L"--read-file",
            (policy_allowed / L".env").wstring()},
        .cwd = policy_allowed.wstring(),
        .workspace_roots = {policy_allowed.wstring()},
        .writable_roots = {policy_allowed.wstring()},
        .denied_read_roots = {},
        .denied_read_globs = {L"**/.env", L"**/.env.*"},
        .filesystem = mycli::sandbox::FilesystemPolicy::kWorkspaceWrite,
        .network = mycli::sandbox::NetworkPolicy::kDisabled,
        .mode = mycli::sandbox::SandboxMode::kWorkspaceWrite,
    };
    if (mycli::sandbox::RunSandboxRequest(
            policy_request, nullptr, account_sid.get()) == 0) {
        std::cerr << "request-level denied-read policy failed\n";
        return 1;
    }
    stage("complete");
    policy_secret_dacl.Restore();
    allowed_secret_dacl.Restore();
    std::filesystem::remove_all(test_root);
    return 0;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
    try {
        if (argc == 3 && std::wstring_view{argv[1]} == L"--spawn-delayed-write") {
            auto command_line = mycli::sandbox::BuildWindowsCommandLine(
                {argv[0], L"--delayed-write", argv[2]});
            std::vector<wchar_t> mutable_command_line(
                command_line.begin(), command_line.end());
            mutable_command_line.push_back(L'\0');
            STARTUPINFOW startup{};
            startup.cb = sizeof(startup);
            PROCESS_INFORMATION process{};
            if (CreateProcessW(
                    nullptr,
                    mutable_command_line.data(),
                    nullptr,
                    nullptr,
                    FALSE,
                    CREATE_NO_WINDOW,
                    nullptr,
                    nullptr,
                    &startup,
                    &process) == 0) {
                return 12;
            }
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            return 0;
        }
        if (argc == 3 && std::wstring_view{argv[1]} == L"--delayed-write") {
            Sleep(750);
            std::ofstream output{std::filesystem::path{argv[2]}};
            output << "late";
            return output ? 0 : 13;
        }
        if (argc == 3 && std::wstring_view{argv[1]} == L"--write-file") {
            std::cerr << "child-write-start\n" << std::flush;
            std::ofstream output{std::filesystem::path{argv[2]}};
            std::cerr << "child-write-opened\n" << std::flush;
            output << "ok";
            output.close();
            std::cerr << "child-write-done\n" << std::flush;
            return output ? 0 : 9;
        }
        if (argc == 3 && std::wstring_view{argv[1]} == L"--read-file") {
            std::cerr << "child-read-start\n" << std::flush;
            std::ifstream input{std::filesystem::path{argv[2]}};
            std::string value;
            input >> value;
            std::cerr << "child-read-done\n" << std::flush;
            return input ? 0 : 10;
        }
        return RunTests(std::filesystem::absolute(argv[0]));
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
