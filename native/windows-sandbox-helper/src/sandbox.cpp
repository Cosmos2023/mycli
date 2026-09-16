#include "sandbox.hpp"

#include <windows.h>
#include <shlwapi.h>

#include <algorithm>
#include <filesystem>
#include <set>
#include <stdexcept>
#include <string_view>
#include <vector>

#include "acl.hpp"
#include "process.hpp"
#include "sid.hpp"
#include "token.hpp"

namespace mycli::sandbox {
namespace {

constexpr std::size_t kMaxDeniedReadMatches = 8192;
constexpr const wchar_t* kProtectedMetadata[] = {L".git", L".agents", L".codex"};

bool IsReparsePoint(const std::filesystem::path& path) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

void RejectReparseTraversal(
    const std::filesystem::path& root,
    const std::filesystem::path& path) {
    auto current = root;
    const auto relative = path.lexically_relative(root);
    for (const auto& component : relative) {
        current /= component;
        if (IsReparsePoint(current)) {
            throw std::runtime_error("denied-read path crosses a reparse point");
        }
    }
}

bool MatchesGlob(const std::filesystem::path& relative, const std::wstring& pattern) {
    const auto value = relative.generic_wstring();
    if (PathMatchSpecExW(value.c_str(), pattern.c_str(), PMSF_NORMAL) == S_OK) {
        return true;
    }
    constexpr std::wstring_view recursive_prefix = L"**/";
    return pattern.starts_with(recursive_prefix) &&
        PathMatchSpecExW(
            value.c_str(),
            pattern.substr(recursive_prefix.size()).c_str(),
            PMSF_NORMAL) == S_OK;
}

std::vector<std::filesystem::path> ResolveDeniedReadPaths(
    const SandboxRequest& request) {
    std::set<std::filesystem::path> matches;
    for (const auto& value : request.denied_read_roots) {
        const std::filesystem::path path{value};
        if (std::filesystem::exists(path)) {
            matches.insert(std::filesystem::weakly_canonical(path));
        }
    }
    if (request.denied_read_globs.empty()) return {matches.begin(), matches.end()};
    for (const auto& root_value : request.workspace_roots) {
        const std::filesystem::path root =
            std::filesystem::weakly_canonical(root_value);
        std::error_code error;
        std::filesystem::recursive_directory_iterator iterator{
            root,
            std::filesystem::directory_options::none,
            error};
        const std::filesystem::recursive_directory_iterator end;
        if (error) {
            throw std::runtime_error("failed to enumerate denied-read globs");
        }
        for (; iterator != end; iterator.increment(error)) {
            if (error) {
                throw std::runtime_error("failed to enumerate denied-read globs");
            }
            const auto& path = iterator->path();
            const auto relative = path.lexically_relative(root);
            if (std::any_of(
                    request.denied_read_globs.begin(),
                    request.denied_read_globs.end(),
                    [&](const std::wstring& pattern) {
                        return MatchesGlob(relative, pattern);
                    })) {
                RejectReparseTraversal(root, path);
                matches.insert(std::filesystem::weakly_canonical(path));
                if (matches.size() > kMaxDeniedReadMatches) {
                    throw std::runtime_error("denied-read glob match limit exceeded");
                }
            }
        }
    }
    return {matches.begin(), matches.end()};
}

std::vector<LocalSid> CapabilitiesForRequest(const SandboxRequest& request) {
    std::vector<LocalSid> capabilities;
    if (request.mode == SandboxMode::kReadOnly || request.writable_roots.empty()) {
        capabilities.push_back(DeriveCapabilitySid(
            std::filesystem::path{request.cwd}, L"read-only"));
        return capabilities;
    }
    capabilities.reserve(request.writable_roots.size());
    for (const auto& root_value : request.writable_roots) {
        capabilities.push_back(DeriveCapabilitySid(
            std::filesystem::path{root_value}, L"workspace-write"));
    }
    return capabilities;
}

DWORD RunWithCapabilities(
    const SandboxRequest& request,
    HANDLE base_token,
    const std::vector<LocalSid>& capabilities) {
    std::vector<PSID> restricting_sids;
    restricting_sids.reserve(capabilities.size());
    for (const auto& capability : capabilities) {
        restricting_sids.push_back(capability.get());
    }
    const auto token = base_token == nullptr
        ? CreateRestrictedPrimaryToken(restricting_sids)
        : CreateRestrictedPrimaryTokenFrom(base_token, restricting_sids);
    return RunProcessInJob(
        token.get(), request.command_argv, std::filesystem::path{request.cwd});
}

}  // namespace

void PrepareSandboxRequest(const SandboxRequest& request, PSID account_sid) {
    // Reject metadata aliases before modifying ACLs. Include workspace roots even
    // when the write allowlist is narrowed to a child directory or file.
    std::set<std::filesystem::path> protected_paths;
    auto protection_roots = request.workspace_roots;
    protection_roots.insert(protection_roots.end(),
        request.writable_roots.begin(), request.writable_roots.end());
    for (const auto& root : protection_roots) {
        for (const auto* name : kProtectedMetadata) {
            const auto path = std::filesystem::path{root} / name;
            if (IsReparsePoint(path)) {
                throw std::runtime_error("protected metadata must not be a reparse point");
            }
            if (std::filesystem::exists(path)) protected_paths.insert(path);
        }
    }
    const auto denied_paths = ResolveDeniedReadPaths(request);
    if (account_sid != nullptr) {
        for (const auto& root_value : request.workspace_roots) {
            GrantReadableRoot(std::filesystem::path{root_value}, account_sid);
        }
        const std::filesystem::path executable{request.command_argv.front()};
        if (executable.is_absolute() && executable.has_parent_path()) {
            const auto install_root = executable.parent_path().has_parent_path()
                ? executable.parent_path().parent_path()
                : executable.parent_path();
            GrantReadableRoot(install_root, account_sid);
        }
    }
    const auto capabilities = CapabilitiesForRequest(request);
    if (request.mode != SandboxMode::kReadOnly) {
        for (std::size_t index = 0; index < request.writable_roots.size(); ++index) {
            const std::filesystem::path root{request.writable_roots[index]};
            GrantWritableRoot(root, capabilities[index].get());
            if (account_sid != nullptr) GrantWritableRoot(root, account_sid);
        }
    }

    for (const auto& capability : capabilities) {
        for (const auto& path : denied_paths) {
            DenyReadPath(path, capability.get());
        }
        for (const auto& path : protected_paths) DenyWritePath(path, capability.get());
    }
    if (account_sid != nullptr) {
        for (const auto& path : denied_paths) DenyReadPath(path, account_sid);
        for (const auto& path : protected_paths) DenyWritePath(path, account_sid);
    }
}

DWORD RunPreparedSandboxRequest(const SandboxRequest& request) {
    return RunWithCapabilities(request, nullptr, CapabilitiesForRequest(request));
}

DWORD RunSandboxRequest(
    const SandboxRequest& request,
    HANDLE base_token,
    PSID account_sid) {
    PrepareSandboxRequest(request, account_sid);
    return RunWithCapabilities(request, base_token, CapabilitiesForRequest(request));
}

}  // namespace mycli::sandbox
