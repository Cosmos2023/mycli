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
    if (Rejects(network_enabled)) {
        std::cerr << "network-enabled request was rejected\n";
        return 1;
    }

    auto proxy = network_enabled;
    proxy.insert(proxy.rfind(L'}'), L", \"network_proxy_port\": 40000");
    if (Rejects(proxy)) {
        std::cerr << "valid proxy request was rejected\n";
        return 1;
    }
    for (const auto* port : {L"0", L"-1", L"65536", L"1.5", L"\"40000\""}) {
        auto invalid_proxy = network_enabled;
        invalid_proxy.insert(invalid_proxy.rfind(L'}'),
            std::wstring{L", \"network_proxy_port\": "} + port);
        if (!Rejects(invalid_proxy)) {
            std::cerr << "invalid proxy port was accepted\n";
            return 1;
        }
    }
    auto offline_proxy = std::wstring{kValidRequest};
    offline_proxy.insert(offline_proxy.rfind(L'}'), L", \"network_proxy_port\": 40000");
    if (!Rejects(offline_proxy)) {
        std::cerr << "offline policy accepted a proxy exception\n";
        return 1;
    }

    std::wstring empty_write_roots{kValidRequest};
    const std::wstring write_roots = LR"("writable_roots": ["C:\\workspace"])";
    empty_write_roots.replace(empty_write_roots.find(write_roots), write_roots.size(),
        L"\"writable_roots\": []");
    if (Rejects(empty_write_roots)) {
        std::cerr << "empty write allowlist was rejected\n";
        return 1;
    }
    std::wstring missing_field{kValidRequest};
    const std::wstring deny_field = LR"(    "denied_read_globs": ["**/.env"],)";
    missing_field.erase(missing_field.find(deny_field), deny_field.size());
    if (!Rejects(missing_field)) {
        std::cerr << "missing protocol field was accepted\n";
        return 1;
    }
    std::wstring embedded_nul{kValidRequest};
    embedded_nul.insert(embedded_nul.find(L"echo ok") + 4, LR"(\u0000)");
    if (!Rejects(embedded_nul)) {
        std::cerr << "embedded NUL was accepted\n";
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
