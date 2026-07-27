#include <windows.h>

#include <exception>
#include <filesystem>
#include <iostream>
#include <fstream>
#include <string>
#include <string_view>
#include <vector>

#include "acl.hpp"
#include "process.hpp"
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

    const auto token = mycli::sandbox::CreateRestrictedPrimaryToken();
    if (IsTokenRestricted(token.get()) == 0) {
        std::cerr << "CreateRestrictedPrimaryToken returned an unrestricted token\n";
        return 1;
    }

    const std::vector<std::wstring> command{
        L"cmd.exe", L"/d", L"/s", L"/c", L"exit 7"};
    const auto exit_code = mycli::sandbox::RunProcessInJob(
        token.get(), command, std::filesystem::current_path());
    if (exit_code != 7) {
        std::cerr << "restricted child returned an unexpected exit code\n";
        return 1;
    }

    const auto test_root = std::filesystem::temp_directory_path() /
        (L"mycli-sandbox-" + std::to_wstring(GetCurrentProcessId()));
    const auto allowed = test_root / L"allowed";
    const auto denied = test_root / L"denied";
    std::filesystem::create_directories(allowed);
    std::filesystem::create_directories(denied);
    const auto capability = mycli::sandbox::DeriveCapabilitySid(allowed);
    mycli::sandbox::GrantWritableRoot(allowed, capability.get());
    const auto write_token = mycli::sandbox::CreateRestrictedPrimaryToken(
        {capability.get()});
    const auto allowed_exit = mycli::sandbox::RunProcessInJob(
        write_token.get(),
        {executable.wstring(), L"--write-file", (allowed / L"ok.txt").wstring()},
        allowed);
    const auto denied_exit = mycli::sandbox::RunProcessInJob(
        write_token.get(),
        {executable.wstring(), L"--write-file", (denied / L"blocked.txt").wstring()},
        denied);
    if (allowed_exit != 0 || denied_exit == 0 ||
        !std::filesystem::exists(allowed / L"ok.txt") ||
        std::filesystem::exists(denied / L"blocked.txt")) {
        std::cerr << "capability ACL write boundary failed\n";
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
        return RunTests(std::filesystem::absolute(argv[0]));
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
