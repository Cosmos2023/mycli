#include <exception>
#include <iostream>
#include <string>

#include "protocol.hpp"

namespace {

constexpr wchar_t kValidRequest[] = LR"({
    "protocol_version": 1,
    "command": {"argv": ["cmd.exe", "/c", "echo ok"]},
    "cwd": "C:\\workspace",
    "workspace_roots": ["C:\\workspace"],
    "writable_roots": ["C:\\workspace"],
    "denied_read_roots": ["C:\\workspace\\secret"],
    "denied_read_globs": ["**/.env"],
    "filesystem": "workspace_write",
    "network": "disabled",
    "mode": "workspace-write"
})";

bool Rejects(const std::wstring& request_json) {
    try {
        static_cast<void>(mycli::sandbox::ParseAndValidateRequest(request_json));
    } catch (const std::exception&) {
        return true;
    }
    return false;
}

int RunTests() {
    const auto request = mycli::sandbox::ParseAndValidateRequest(kValidRequest);
    if (request.protocol_version != mycli::sandbox::kProtocolVersion ||
        request.command_argv.size() != 3 || request.writable_roots.size() != 1) {
        std::cerr << "valid request was parsed incorrectly\n";
        return 1;
    }

    std::wstring wrong_version{kValidRequest};
    wrong_version.replace(
        wrong_version.find(L"\"protocol_version\": 1"),
        std::wstring{L"\"protocol_version\": 1"}.size(),
        L"\"protocol_version\": 2");
    if (!Rejects(wrong_version)) {
        std::cerr << "protocol mismatch was accepted\n";
        return 1;
    }

    std::wstring network_enabled{kValidRequest};
    network_enabled.replace(
        network_enabled.find(L"\"network\": \"disabled\""),
        std::wstring{L"\"network\": \"disabled\""}.size(),
        L"\"network\": \"enabled\"");
    if (!Rejects(network_enabled)) {
        std::cerr << "network-enabled request was accepted\n";
        return 1;
    }

    std::wstring unknown_field{kValidRequest};
    unknown_field.insert(unknown_field.rfind(L'}'), L", \"unexpected\": true");
    if (!Rejects(unknown_field)) {
        std::cerr << "unknown request field was accepted\n";
        return 1;
    }
    return 0;
}

}  // namespace

int wmain() {
    try {
        return RunTests();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
    }
    return 1;
}
