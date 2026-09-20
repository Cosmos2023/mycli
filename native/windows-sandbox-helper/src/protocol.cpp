#include "protocol.hpp"

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <wincrypt.h>

#include <algorithm>
#include <filesystem>
#include <initializer_list>
#include <stdexcept>
#include <string_view>

#include <nlohmann/json.hpp>

namespace mycli::sandbox {
namespace {

using Json = nlohmann::json;
constexpr std::size_t kMaxRoots = 1024;
constexpr std::size_t kMaxDeniedGlobs = 8192;
constexpr std::size_t kMaxEgressRules = 32;
constexpr std::size_t kMaxEgressDestinations = 8;
constexpr std::size_t kMaxEgressPorts = 8;

std::string WideToUtf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int bytes = WideCharToMultiByte(
        CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
        nullptr, 0, nullptr, nullptr);
    if (bytes <= 0) throw std::runtime_error("request contains invalid UTF-16");
    std::string output(static_cast<std::size_t>(bytes), '\0');
    if (WideCharToMultiByte(
            CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
            output.data(), bytes, nullptr, nullptr) != bytes) {
        throw std::runtime_error("failed to convert request to UTF-8");
    }
    return output;
}

std::wstring Utf8ToWide(const std::string& value) {
    if (value.find('\0') != std::string::npos) {
        throw std::runtime_error("request strings must not contain NUL");
    }
    if (value.empty()) return {};
    const int chars = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
        nullptr, 0);
    if (chars <= 0) throw std::runtime_error("request contains invalid UTF-8");
    std::wstring output(static_cast<std::size_t>(chars), L'\0');
    if (MultiByteToWideChar(
            CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
            output.data(), chars) != chars) {
        throw std::runtime_error("failed to convert request from UTF-8");
    }
    return output;
}

void RequireKnownFields(
    const Json& object,
    std::initializer_list<std::string_view> known_fields) {
    if (!object.is_object()) throw std::runtime_error("request value must be an object");
    for (const auto& [key, value] : object.items()) {
        static_cast<void>(value);
        if (std::find(known_fields.begin(), known_fields.end(), key) == known_fields.end()) {
            throw std::runtime_error("request contains an unknown field");
        }
    }
}

std::wstring RequireString(const Json& object, const char* key) {
    const auto& value = object.at(key);
    if (!value.is_string()) throw std::runtime_error("request field must be a string");
    return Utf8ToWide(value.get_ref<const std::string&>());
}

std::vector<std::wstring> RequireStringArray(
    const Json& object,
    const char* key,
    std::size_t limit) {
    const auto& array = object.at(key);
    if (!array.is_array()) throw std::runtime_error("request field must be an array");
    if (array.size() > limit) throw std::runtime_error("request array exceeds its size limit");
    std::vector<std::wstring> values;
    values.reserve(array.size());
    for (const auto& value : array) {
        if (!value.is_string()) {
            throw std::runtime_error("request array must contain only strings");
        }
        values.push_back(Utf8ToWide(value.get_ref<const std::string&>()));
    }
    return values;
}

void RequireAbsolutePaths(
    const std::vector<std::wstring>& paths,
    const char* field_name) {
    for (const auto& path : paths) {
        if (path.empty() || !std::filesystem::path{path}.is_absolute()) {
            throw std::runtime_error(std::string{field_name} + " must contain absolute paths");
        }
    }
}

FilesystemPolicy ParseFilesystem(const std::wstring& value) {
    if (value == L"read_only") return FilesystemPolicy::kReadOnly;
    if (value == L"workspace_write") return FilesystemPolicy::kWorkspaceWrite;
    if (value == L"unrestricted") return FilesystemPolicy::kUnrestricted;
    throw std::runtime_error("unsupported filesystem policy");
}

NetworkPolicy ParseNetwork(const std::wstring& value) {
    if (value == L"disabled") return NetworkPolicy::kDisabled;
    if (value == L"enabled") return NetworkPolicy::kEnabled;
    throw std::runtime_error("unsupported network policy");
}

SandboxMode ParseMode(const std::wstring& value) {
    if (value == L"read-only") return SandboxMode::kReadOnly;
    if (value == L"workspace-write") return SandboxMode::kWorkspaceWrite;
    if (value == L"danger-full-access") return SandboxMode::kFullAccess;
    throw std::runtime_error("unsupported sandbox mode");
}

bool IsDecimal(const std::wstring& value) {
    return !value.empty() && std::all_of(value.begin(), value.end(),
        [](wchar_t character) { return character >= L'0' && character <= L'9'; });
}

bool ValidCidr(const std::wstring& value) {
    const auto separator = value.find(L'/');
    if (separator == std::wstring::npos || separator == 0 || separator + 1 >= value.size() ||
        value.find(L'/', separator + 1) != std::wstring::npos) return false;
    const auto address = value.substr(0, separator);
    const auto prefix = value.substr(separator + 1);
    if (prefix.size() > 3 || !IsDecimal(prefix)) return false;
    IN_ADDR ipv4{};
    IN6_ADDR ipv6{};
    const int family = InetPtonW(AF_INET, address.c_str(), &ipv4) == 1
        ? 4 : InetPtonW(AF_INET6, address.c_str(), &ipv6) == 1 ? 6 : 0;
    if (family == 0) return false;
    const int length = std::stoi(prefix);
    return family == 4 ? length <= 32 : length <= 128;
}

NetworkRuleProtocol ParseRuleProtocol(const std::wstring& value) {
    if (value == L"any") return NetworkRuleProtocol::kAny;
    if (value == L"tcp") return NetworkRuleProtocol::kTcp;
    if (value == L"udp") return NetworkRuleProtocol::kUdp;
    if (value == L"icmpv4") return NetworkRuleProtocol::kIcmpV4;
    if (value == L"icmpv6") return NetworkRuleProtocol::kIcmpV6;
    throw std::runtime_error("unsupported network rule protocol");
}

std::vector<NetworkEgressRule> ParseEgressRules(const Json& value, const char* key) {
    if (!value.contains(key)) return {};
    const auto& array = value.at(key);
    if (!array.is_array() || array.empty() || array.size() > kMaxEgressRules) {
        throw std::runtime_error("invalid network egress rule list");
    }
    std::vector<NetworkEgressRule> rules;
    rules.reserve(array.size());
    for (const auto& entry : array) {
        RequireKnownFields(entry, {"to", "ports"});
        NetworkEgressRule rule;
        const auto& destinations = entry.at("to");
        if (!destinations.is_array() || destinations.empty() ||
            destinations.size() > kMaxEgressDestinations) {
            throw std::runtime_error("invalid network egress destinations");
        }
        for (const auto& destination : destinations) {
            RequireKnownFields(destination, {"cidr", "except"});
            NetworkDestination parsed;
            parsed.cidr = RequireString(destination, "cidr");
            if (!ValidCidr(parsed.cidr)) throw std::runtime_error("invalid network egress CIDR");
            if (destination.contains("except")) {
                parsed.except = RequireStringArray(destination, "except", kMaxEgressDestinations);
                if (parsed.except.empty()) throw std::runtime_error("network egress exceptions must not be empty");
                for (const auto& exception : parsed.except) {
                    if (!ValidCidr(exception)) throw std::runtime_error("invalid network egress exception CIDR");
                }
            }
            rule.destinations.push_back(std::move(parsed));
        }
        if (entry.contains("ports")) {
            const auto& ports = entry.at("ports");
            if (!ports.is_array() || ports.empty() || ports.size() > kMaxEgressPorts) {
                throw std::runtime_error("invalid network egress ports");
            }
            for (const auto& port : ports) {
                RequireKnownFields(port, {"protocol", "port", "end_port"});
                NetworkPortRule parsed;
                if (port.contains("protocol")) {
                    parsed.protocol = ParseRuleProtocol(RequireString(port, "protocol"));
                }
                const auto read_port = [&](const char* field) -> unsigned short {
                    if (!port.contains(field)) return 0;
                    const auto& value = port.at(field);
                    if (!value.is_number_unsigned() || value.get<std::uint64_t>() > 65535) {
                        throw std::runtime_error("invalid network egress port");
                    }
                    return static_cast<unsigned short>(value.get<std::uint64_t>());
                };
                parsed.port = read_port("port");
                parsed.end_port = read_port("end_port");
                if (port.contains("end_port") && !port.contains("port")) {
                    throw std::runtime_error("network egress end_port requires port");
                }
                if (parsed.end_port != 0 && parsed.end_port < parsed.port) {
                    throw std::runtime_error("network egress port range is inverted");
                }
                rule.ports.push_back(parsed);
            }
        }
        rules.push_back(std::move(rule));
    }
    return rules;
}

std::optional<NetworkEgressPolicy> ParseNetworkEgress(const Json& root) {
    if (!root.contains("network_egress")) return std::nullopt;
    const auto& value = root.at("network_egress");
    RequireKnownFields(value, {"default", "allow", "deny"});
    const auto default_action = RequireString(value, "default");
    NetworkEgressPolicy policy;
    // Host loopback is authorized only by an explicit allow rule, so a structured
    // policy must be a deny-by-default allowlist. "Allow everything" is expressed by
    // enabling networking without rules.
    if (default_action != L"deny") {
        throw std::runtime_error("network egress rules require a deny default");
    }
    policy.allow_default = false;
    policy.allow = ParseEgressRules(value, "allow");
    policy.deny = ParseEgressRules(value, "deny");
    return policy;
}

}  // namespace

SandboxRequest ParseAndValidateRequest(const std::wstring& request_json) {
    if (request_json.size() > 1000000) {
        throw std::runtime_error("sandbox request exceeds payload size limit");
    }
    const auto bytes = WideToUtf8(request_json);
    if (bytes.size() > 1000000) throw std::runtime_error("sandbox request exceeds payload size limit");
    const Json root = Json::parse(bytes);
    RequireKnownFields(
        root,
        {"protocol_version", "command", "cwd", "workspace_roots", "writable_roots",
         "denied_read_roots", "denied_read_globs", "filesystem", "network", "mode",
         "network_proxy_port", "network_egress", "readable_roots", "readonly_roots",
         "allow_local_binding", "writable_tmp"});
    const auto& version = root.at("protocol_version");
    if (!version.is_number_unsigned() || version.get<std::uint64_t>() != kProtocolVersion) {
        throw std::runtime_error("sandbox protocol version mismatch");
    }
    const auto& command = root.at("command");
    RequireKnownFields(command, {"argv"});

    SandboxRequest request{
        .protocol_version = version.get<std::uint32_t>(),
        .command_argv = RequireStringArray(command, "argv", 4096),
        .cwd = RequireString(root, "cwd"),
        .workspace_roots = RequireStringArray(root, "workspace_roots", kMaxRoots),
        .writable_roots = RequireStringArray(root, "writable_roots", kMaxRoots),
        .denied_read_roots = RequireStringArray(root, "denied_read_roots", kMaxRoots),
        .denied_read_globs = RequireStringArray(root, "denied_read_globs", kMaxDeniedGlobs),
        .filesystem = ParseFilesystem(RequireString(root, "filesystem")),
        .network = ParseNetwork(RequireString(root, "network")),
        .mode = ParseMode(RequireString(root, "mode")),
    };
    if (!request.denied_read_globs.empty()) throw std::runtime_error("runtime must resolve denied-read globs");
    request.explicit_read_roots = root.contains("readable_roots");
    for (const auto* field : {"readable_roots", "readonly_roots", "allow_local_binding", "writable_tmp"}) {
        request.has_psec_options = request.has_psec_options || root.contains(field);
    }
    if (request.explicit_read_roots) request.readable_roots = RequireStringArray(root, "readable_roots", kMaxRoots);
    if (root.contains("readonly_roots")) request.readonly_roots = RequireStringArray(root, "readonly_roots", kMaxRoots);
    for (const auto* field : {"allow_local_binding", "writable_tmp"}) {
        if (root.contains(field) && !root.at(field).is_boolean()) throw std::runtime_error("invalid sandbox boolean");
    }
    request.allow_local_binding = root.value("allow_local_binding", false);
    request.writable_tmp = root.value("writable_tmp", request.mode != SandboxMode::kReadOnly);
    if (root.contains("network_proxy_port")) {
        const auto& port = root.at("network_proxy_port");
        if (!port.is_number_unsigned() || port.get<std::uint64_t>() < 1 ||
            port.get<std::uint64_t>() > 65535 || request.network != NetworkPolicy::kEnabled) {
            throw std::runtime_error("invalid sandbox network proxy endpoint");
        }
        request.network_proxy_port = port.get<unsigned short>();
    }
    request.network_egress = ParseNetworkEgress(root);
    if (request.network_egress.has_value()) {
        if (request.network != NetworkPolicy::kEnabled || request.network_proxy_port != 0) {
            throw std::runtime_error("network egress rules require enabled networking without a proxy");
        }
        request.has_psec_options = true;
    }
    if (request.command_argv.empty() || request.command_argv.front().empty()) {
        throw std::runtime_error("command argv must contain a non-empty executable");
    }
    if (request.cwd.empty() || !std::filesystem::path{request.cwd}.is_absolute()) {
        throw std::runtime_error("cwd must be an absolute path");
    }
    if (request.workspace_roots.empty()) {
        throw std::runtime_error("workspace_roots must not be empty");
    }
    RequireAbsolutePaths(request.workspace_roots, "workspace_roots");
    RequireAbsolutePaths(request.writable_roots, "writable_roots");
    RequireAbsolutePaths(request.denied_read_roots, "denied_read_roots");
    RequireAbsolutePaths(request.readable_roots, "readable_roots");
    RequireAbsolutePaths(request.readonly_roots, "readonly_roots");
    if (std::any_of(
            request.denied_read_globs.begin(), request.denied_read_globs.end(),
            [](const std::wstring& value) { return value.empty(); })) {
        throw std::runtime_error("denied_read_globs must not contain empty patterns");
    }
    if (request.mode == SandboxMode::kReadOnly) {
        if (request.filesystem != FilesystemPolicy::kReadOnly ||
            !request.writable_roots.empty()) {
            throw std::runtime_error("read-only request contains writable policy");
        }
    } else if (request.mode == SandboxMode::kFullAccess) {
        if (request.filesystem != FilesystemPolicy::kUnrestricted) throw std::runtime_error("full-access request has incompatible filesystem policy");
    } else if (request.filesystem != FilesystemPolicy::kWorkspaceWrite) {
        throw std::runtime_error("workspace-write request has incompatible filesystem policy");
    }
    return request;
}

std::wstring ReadRequestEnvironment() {
    wchar_t count_text[8]{};
    const DWORD count_size = GetEnvironmentVariableW(L"MYCLI_SANDBOX_REQUEST_COUNT", count_text, 8);
    if (count_size == 0 || count_size >= 8) throw std::runtime_error("sandbox request carrier invalid");
    unsigned count = 0;
    for (DWORD index = 0; index < count_size; ++index) {
        if (count_text[index] < L'0' || count_text[index] > L'9') throw std::runtime_error("sandbox request carrier invalid");
        count = count * 10 + static_cast<unsigned>(count_text[index] - L'0');
    }
    if (count == 0 || count > 326) throw std::runtime_error("sandbox request carrier invalid");
    std::wstring encoded;
    for (unsigned index = 0; index < count; ++index) {
        const auto name = L"MYCLI_SANDBOX_REQUEST_" + std::to_wstring(index);
        wchar_t chunk[4097]{};
        const DWORD size = GetEnvironmentVariableW(name.c_str(), chunk, 4097);
        if (size == 0 || size > 4096 || (index + 1 < count && size != 4096)) {
            throw std::runtime_error("sandbox request carrier invalid");
        }
        encoded.append(chunk, size);
    }
    DWORD size = 0;
    if (CryptStringToBinaryW(encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT,
            nullptr, &size, nullptr, nullptr) == 0 || size > 1000000) throw std::runtime_error("sandbox request carrier invalid");
    std::string bytes(size, '\0');
    if (CryptStringToBinaryW(encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT,
            reinterpret_cast<BYTE*>(bytes.data()), &size, nullptr, nullptr) == 0) throw std::runtime_error("sandbox request carrier invalid");
    return Utf8ToWide(bytes);
}

void ClearRequestEnvironment() {
    const auto block = GetEnvironmentStringsW();
    if (block == nullptr) throw std::runtime_error("sandbox environment unavailable");
    std::vector<std::wstring> names;
    for (const wchar_t* entry = block; *entry != L'\0'; entry += wcslen(entry) + 1) {
        const std::wstring value{entry};
        if (_wcsnicmp(value.c_str(), L"MYCLI_SANDBOX_REQUEST_", 22) == 0) names.push_back(value.substr(0, value.find(L'=')));
    }
    FreeEnvironmentStringsW(block);
    for (const auto& name : names) {
        if (SetEnvironmentVariableW(name.c_str(), nullptr) == 0) throw std::runtime_error("sandbox carrier cleanup failed");
    }
}

}  // namespace mycli::sandbox
