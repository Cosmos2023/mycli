#include <exception>
#include <iostream>
#include <string>

#include "protocol.hpp"

namespace {

constexpr wchar_t kValidRequest[] = LR"({
    "protocol_version": 2,
    "command": {"argv": ["cmd.exe", "/c", "echo ok"]},
    "cwd": "C:\\workspace",
    "workspace_roots": ["C:\\workspace"],
    "writable_roots": ["C:\\workspace"],
    "denied_read_roots": ["C:\\workspace\\secret"],
    "denied_read_globs": [],
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
        wrong_version.find(L"\"protocol_version\": 2"),
        std::wstring{L"\"protocol_version\": 2"}.size(),
        L"\"protocol_version\": 1");
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

    auto egress = network_enabled;
    egress.insert(egress.rfind(L'}'), LR"(, "network_egress": {"default": "deny", "allow": [
        {"to": [{"cidr": "127.0.0.0/8", "except": ["127.0.0.2/32"]}],
         "ports": [{"protocol": "tcp", "port": 443, "end_port": 444}]}]})");
    const auto egress_request = mycli::sandbox::ParseAndValidateRequest(egress);
    if (!egress_request.network_egress.has_value() || !egress_request.has_psec_options
        || egress_request.network_egress->allow_default
        || egress_request.network_egress->allow.size() != 1
        || egress_request.network_egress->allow.front().destinations.size() != 1
        || egress_request.network_egress->allow.front().ports.front().end_port != 444) {
        std::cerr << "valid network egress policy was parsed incorrectly\n";
        return 1;
    }
    for (const auto* invalid : {
            LR"({"default": "maybe"})",
            LR"({"default": "allow", "allow": [{"to": [{"cidr": "10.0.0.0/8"}]}]})",
            LR"({"default": "deny", "allow": []})",
            LR"({"default": "deny", "allow": [{"to": []}]})",
            LR"({"default": "deny", "allow": [{"to": [{"cidr": "10.0.0.0"}]}]})",
            LR"({"default": "deny", "allow": [{"to": [{"cidr": "10.0.0.0/33"}]}]})",
            LR"({"default": "deny", "allow": [{"to": [{"cidr": "::1/129"}]}]})",
            LR"({"default": "deny", "allow": [{"to": [{"cidr": "10.0.0.0/8"}], "ports": [{"protocol": "sctp"}]}]})",
            LR"({"default": "deny", "allow": [{"to": [{"cidr": "10.0.0.0/8"}], "ports": [{"end_port": 443}]}]})",
            LR"({"default": "deny", "allow": [{"to": [{"cidr": "10.0.0.0/8"}], "ports": [{"port": 500, "end_port": 400}]}]})",
            LR"({"default": "deny", "allow": [{"to": [{"cidr": "10.0.0.0/8"}], "unknown": true}]})"}) {
        auto invalid_egress = network_enabled;
        invalid_egress.insert(invalid_egress.rfind(L'}'),
            std::wstring{L", \"network_egress\": "} + invalid);
        if (!Rejects(invalid_egress)) {
            std::cerr << "invalid network egress policy was accepted\n";
            return 1;
        }
    }
    auto egress_with_proxy = egress;
    egress_with_proxy.insert(egress_with_proxy.rfind(L'}'), L", \"network_proxy_port\": 40000");
    if (!Rejects(egress_with_proxy)) {
        std::cerr << "network egress with a managed proxy was accepted\n";
        return 1;
    }
    auto egress_without_network = std::wstring{kValidRequest};
    egress_without_network.insert(egress_without_network.rfind(L'}'),
        LR"(, "network_egress": {"default": "deny", "allow": [{"to": [{"cidr": "10.0.0.0/8"}]}]})");
    if (!Rejects(egress_without_network)) {
        std::cerr << "network egress with disabled networking was accepted\n";
        return 1;
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
    const std::wstring deny_field = LR"(    "denied_read_globs": [],)";
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
    auto advanced = std::wstring{kValidRequest};
    advanced.insert(advanced.rfind(L'}'), LR"(, "readable_roots": ["C:\\shared"],
        "readonly_roots": ["C:\\workspace\\vendor"], "allow_local_binding": true, "writable_tmp": false)");
    const auto parsed = mycli::sandbox::ParseAndValidateRequest(advanced);
    if (!parsed.has_psec_options || !parsed.explicit_read_roots || !parsed.allow_local_binding ||
        parsed.writable_tmp || parsed.readable_roots.size() != 1 || parsed.readonly_roots.size() != 1 ||
        request.has_psec_options || !request.writable_tmp) {
        std::cerr << "PSEC options or legacy defaults were parsed incorrectly\n";
        return 1;
    }
    for (const auto* field : {L"allow_local_binding", L"writable_tmp"}) {
        for (const auto* value : {L"null", L"0", L"\"false\"", L"[]"}) {
            auto invalid = std::wstring{kValidRequest};
            invalid.insert(invalid.rfind(L'}'), std::wstring{L", \""} + field + L"\": " + value);
            if (!Rejects(invalid)) {
                std::cerr << "invalid PSEC boolean was accepted\n";
                return 1;
            }
        }
    }
    auto relative_root = std::wstring{kValidRequest};
    relative_root.insert(relative_root.rfind(L'}'), LR"(, "readonly_roots": ["relative"])");
    if (!Rejects(relative_root) || !Rejects(std::wstring(1000001, L' '))) {
        std::cerr << "invalid path or oversized PSEC payload was accepted\n";
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
