#include <windows.h>

#include <exception>
#include <filesystem>
#include <iostream>
#include <fstream>
#include <string>
#include <string_view>
#include <vector>

#include "acl.hpp"
#include "identity.hpp"
#include "process.hpp"
#include "sandbox.hpp"
#include "sid.hpp"
#include "token.hpp"

namespace {

int RunTests(const std::filesystem::path& executable) {
    using mycli::sandbox::QuoteWindowsArgument;
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

    const auto test_root = std::filesystem::temp_directory_path() /
        (L"mycli-sandbox-" + std::to_wstring(GetCurrentProcessId()));
    const auto allowed = test_root / L"allowed";
    const auto denied = test_root / L"denied";
    std::filesystem::create_directories(allowed);
    std::filesystem::create_directories(denied);
    std::filesystem::create_directories(allowed / L".git");
    {
        std::ofstream secret{allowed / L".env"};
        secret << "secret";
    }
    const auto capability = mycli::sandbox::DeriveCapabilitySid(
        allowed, L"workspace-write");
    const auto read_only_capability = mycli::sandbox::DeriveCapabilitySid(
        allowed, L"read-only");
    if (EqualSid(capability.get(), read_only_capability.get()) != 0) {
        std::cerr << "read-only and workspace-write capability SIDs collided\n";
        return 1;
    }
    mycli::sandbox::GrantWritableRoot(allowed, capability.get());
    mycli::sandbox::DenyReadPath(allowed / L".env", capability.get());
    mycli::sandbox::DenyWritePath(allowed / L".git", capability.get());
    const auto write_token = mycli::sandbox::CreateRestrictedPrimaryToken(
        {capability.get()});
    if (IsTokenRestricted(write_token.get()) == 0) {
        std::cerr << "capability token is not restricted\n";
        return 1;
    }
    const auto exit_code = mycli::sandbox::RunProcessInJob(
        write_token.get(), command, std::filesystem::current_path());
    if (exit_code != 7) {
        std::cerr << "restricted child returned an unexpected exit code\n";
        return 1;
    }
    const auto allowed_exit = mycli::sandbox::RunProcessInJob(
        write_token.get(),
        {executable.wstring(), L"--write-file", (allowed / L"ok.txt").wstring()},
        allowed);
    const auto denied_exit = mycli::sandbox::RunProcessInJob(
        write_token.get(),
        {executable.wstring(), L"--write-file", (denied / L"blocked.txt").wstring()},
        denied);
    const auto secret_read_exit = mycli::sandbox::RunProcessInJob(
        write_token.get(),
        {executable.wstring(), L"--read-file", (allowed / L".env").wstring()},
        allowed);
    const auto metadata_write_exit = mycli::sandbox::RunProcessInJob(
        write_token.get(),
        {executable.wstring(), L"--write-file", (allowed / L".git" / L"config").wstring()},
        allowed);
    if (allowed_exit != 0 || denied_exit == 0 ||
        secret_read_exit == 0 || metadata_write_exit == 0 ||
        !std::filesystem::exists(allowed / L"ok.txt") ||
        std::filesystem::exists(denied / L"blocked.txt") ||
        std::filesystem::exists(allowed / L".git" / L"config")) {
        std::cerr << "capability ACL write boundary failed\n";
        return 1;
    }

    const mycli::sandbox::SandboxRequest policy_request{
        .protocol_version = mycli::sandbox::kProtocolVersion,
        .command_argv = {
            executable.wstring(),
            L"--read-file",
            (allowed / L".env").wstring()},
        .cwd = allowed.wstring(),
        .workspace_roots = {allowed.wstring()},
        .writable_roots = {allowed.wstring()},
        .denied_read_roots = {},
        .denied_read_globs = {L"**/.env", L"**/.env.*"},
        .filesystem = mycli::sandbox::FilesystemPolicy::kWorkspaceWrite,
        .network = mycli::sandbox::NetworkPolicy::kDisabled,
        .mode = mycli::sandbox::SandboxMode::kWorkspaceWrite,
    };
    if (mycli::sandbox::RunSandboxRequest(policy_request) == 0) {
        std::cerr << "request-level denied-read policy failed\n";
        return 1;
    }
    std::filesystem::remove_all(test_root);
    return 0;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
    try {
        if (argc == 3 && std::wstring_view{argv[1]} == L"--write-file") {
            std::ofstream output{std::filesystem::path{argv[2]}};
            output << "ok";
            return output ? 0 : 9;
        }
        if (argc == 3 && std::wstring_view{argv[1]} == L"--read-file") {
            std::ifstream input{std::filesystem::path{argv[2]}};
            std::string value;
            input >> value;
            return input ? 0 : 10;
        }
        return RunTests(std::filesystem::absolute(argv[0]));
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
