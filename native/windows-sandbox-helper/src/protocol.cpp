#include "protocol.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <initializer_list>
#include <stdexcept>
#include <string_view>

#include <winrt/Windows.Data.Json.h>

namespace mycli::sandbox {
namespace {

using winrt::Windows::Data::Json::JsonArray;
using winrt::Windows::Data::Json::JsonObject;
using winrt::Windows::Data::Json::JsonValueType;

constexpr std::uint32_t kMaxRoots = 1024;
constexpr std::uint32_t kMaxDeniedGlobs = 8192;

void RequireKnownFields(
    const JsonObject& object,
    std::initializer_list<std::wstring_view> known_fields) {
    for (const auto& entry : object) {
        const auto key_string = entry.Key();
        const std::wstring_view key{key_string.c_str(), key_string.size()};
        if (std::find(known_fields.begin(), known_fields.end(), key) == known_fields.end()) {
            throw std::runtime_error("request contains an unknown field");
        }
    }
}

std::wstring RequireString(const JsonObject& object, const wchar_t* key) {
    const auto value = object.GetNamedValue(key);
    if (value.ValueType() != JsonValueType::String) {
        throw std::runtime_error("request field must be a string");
    }
    const auto text = value.GetString();
    return std::wstring{text.c_str(), text.size()};
}

std::vector<std::wstring> RequireStringArray(
    const JsonObject& object,
    const wchar_t* key,
    std::uint32_t limit) {
    const JsonArray array = object.GetNamedArray(key);
    if (array.Size() > limit) {
        throw std::runtime_error("request array exceeds its size limit");
    }
    std::vector<std::wstring> values;
    values.reserve(array.Size());
    for (const auto& value : array) {
        if (value.ValueType() != JsonValueType::String) {
            throw std::runtime_error("request array must contain only strings");
        }
        const auto text = value.GetString();
        values.emplace_back(text.c_str(), text.size());
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
    if (value == L"read_only") {
        return FilesystemPolicy::kReadOnly;
    }
    if (value == L"workspace_write") {
        return FilesystemPolicy::kWorkspaceWrite;
    }
    throw std::runtime_error("unsupported filesystem policy");
}

NetworkPolicy ParseNetwork(const std::wstring& value) {
    if (value == L"disabled") {
        return NetworkPolicy::kDisabled;
    }
    if (value == L"enabled") {
        return NetworkPolicy::kEnabled;
    }
    throw std::runtime_error("unsupported network policy");
}

SandboxMode ParseMode(const std::wstring& value) {
    if (value == L"read-only") {
        return SandboxMode::kReadOnly;
    }
    if (value == L"workspace-write") {
        return SandboxMode::kWorkspaceWrite;
    }
    throw std::runtime_error("unsupported sandbox mode");
}

}  // namespace

SandboxRequest ParseAndValidateRequest(const std::wstring& request_json) {
    const JsonObject root = JsonObject::Parse(winrt::hstring{request_json});
    RequireKnownFields(
        root,
        {L"protocol_version", L"command", L"cwd", L"workspace_roots",
         L"writable_roots", L"denied_read_roots", L"denied_read_globs",
         L"filesystem", L"network", L"mode"});

    const double raw_version = root.GetNamedNumber(L"protocol_version");
    if (!std::isfinite(raw_version) || std::floor(raw_version) != raw_version ||
        raw_version != kProtocolVersion) {
        throw std::runtime_error("sandbox protocol version mismatch");
    }

    const JsonObject command = root.GetNamedObject(L"command");
    RequireKnownFields(command, {L"argv"});

    SandboxRequest request{
        .protocol_version = static_cast<std::uint32_t>(raw_version),
        .command_argv = RequireStringArray(command, L"argv", 4096),
        .cwd = RequireString(root, L"cwd"),
        .workspace_roots = RequireStringArray(root, L"workspace_roots", kMaxRoots),
        .writable_roots = RequireStringArray(root, L"writable_roots", kMaxRoots),
        .denied_read_roots = RequireStringArray(root, L"denied_read_roots", kMaxRoots),
        .denied_read_globs = RequireStringArray(root, L"denied_read_globs", kMaxDeniedGlobs),
        .filesystem = ParseFilesystem(RequireString(root, L"filesystem")),
        .network = ParseNetwork(RequireString(root, L"network")),
        .mode = ParseMode(RequireString(root, L"mode")),
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
            request.denied_read_globs.begin(),
            request.denied_read_globs.end(),
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
