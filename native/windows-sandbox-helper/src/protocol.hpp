#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace mycli::sandbox {

inline constexpr std::uint32_t kProtocolVersion = 2;

enum class FilesystemPolicy {
    kReadOnly,
    kWorkspaceWrite,
};

enum class NetworkPolicy {
    kDisabled,
    kEnabled,
};

enum class SandboxMode {
    kReadOnly,
    kWorkspaceWrite,
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
};

SandboxRequest ParseAndValidateRequest(const std::wstring& request_json);

}  // namespace mycli::sandbox
