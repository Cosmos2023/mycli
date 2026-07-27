#include "protocol.hpp"

#include <windows.h>

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
    throw std::runtime_error("unsupported sandbox mode");
}

}  // namespace

SandboxRequest ParseAndValidateRequest(const std::wstring& request_json) {
    const Json root = Json::parse(WideToUtf8(request_json));
    RequireKnownFields(
        root,
        {"protocol_version", "command", "cwd", "workspace_roots", "writable_roots",
         "denied_read_roots", "denied_read_globs", "filesystem", "network", "mode"});
    const auto& version = root.at("protocol_version");
    if (!version.is_number_unsigned() || version.get<std::uint32_t>() != kProtocolVersion) {
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
    if (std::any_of(
            request.denied_read_globs.begin(), request.denied_read_globs.end(),
            [](const std::wstring& value) { return value.empty(); })) {
        throw std::runtime_error("denied_read_globs must not contain empty patterns");
    }
    if (request.network != NetworkPolicy::kDisabled) {
        throw std::runtime_error("restricted Windows sandbox requires network=disabled");
    }
    if (request.mode == SandboxMode::kReadOnly) {
        if (request.filesystem != FilesystemPolicy::kReadOnly ||
            !request.writable_roots.empty()) {
            throw std::runtime_error("read-only request contains writable policy");
        }
    } else if (request.filesystem != FilesystemPolicy::kWorkspaceWrite ||
               request.writable_roots.empty()) {
        throw std::runtime_error("workspace-write request is missing writable roots");
    }
    return request;
}

}  // namespace mycli::sandbox
