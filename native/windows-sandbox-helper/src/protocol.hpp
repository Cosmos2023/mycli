#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace mycli::sandbox {

inline constexpr std::uint32_t kProtocolVersion = 2;

enum class FilesystemPolicy {
    kReadOnly,
    kWorkspaceWrite,
    kUnrestricted,
};

enum class NetworkPolicy {
    kDisabled,
    kEnabled,
};

enum class SandboxMode {
    kReadOnly,
    kWorkspaceWrite,
    kFullAccess,
};

enum class NetworkRuleProtocol {
    kAny,
    kTcp,
    kUdp,
    kIcmpV4,
    kIcmpV6,
};

struct NetworkPortRule {
    NetworkRuleProtocol protocol = NetworkRuleProtocol::kAny;
    unsigned short port = 0;
    unsigned short end_port = 0;
};

struct NetworkDestination {
    std::wstring cidr;
    std::vector<std::wstring> except;
};

struct NetworkEgressRule {
    std::vector<NetworkDestination> destinations;
    std::vector<NetworkPortRule> ports;
};

struct NetworkEgressPolicy {
    bool allow_default = false;
    std::vector<NetworkEgressRule> allow;
    std::vector<NetworkEgressRule> deny;
};

struct SandboxRequest {
    std::uint32_t protocol_version;
    std::vector<std::wstring> command_argv;
    std::wstring cwd;
    std::vector<std::wstring> workspace_roots;
    std::vector<std::wstring> writable_roots;
    std::vector<std::wstring> denied_read_roots;
    std::vector<std::wstring> denied_read_globs;
    FilesystemPolicy filesystem;
    NetworkPolicy network;
    SandboxMode mode;
    unsigned short network_proxy_port = 0;
    std::vector<std::wstring> readable_roots;
    std::vector<std::wstring> readonly_roots;
    bool explicit_read_roots = false;
    bool allow_local_binding = false;
    bool writable_tmp = false;
    bool has_psec_options = false;
    std::optional<NetworkEgressPolicy> network_egress;
};

SandboxRequest ParseAndValidateRequest(const std::wstring& request_json);
std::wstring ReadRequestEnvironment();
void ClearRequestEnvironment();

}  // namespace mycli::sandbox
