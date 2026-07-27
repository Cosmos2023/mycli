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
    const auto relative = std::filesystem::relative(path, root);
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
    for (const auto& root_value : request.workspace_roots) {
        const std::filesystem::path root =
            std::filesystem::weakly_canonical(root_value);
        std::error_code error;
        std::filesystem::recursive_directory_iterator iterator{
            root,
            std::filesystem::directory_options::skip_permission_denied,
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
            const auto relative = std::filesystem::relative(path, root, error);
            if (error) {
                throw std::runtime_error("failed to resolve denied-read path");
            }
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

}  // namespace

DWORD RunSandboxRequest(
    const SandboxRequest& request,
    HANDLE base_token,
    PSID account_sid) {
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
    std::vector<LocalSid> capabilities;
    if (request.mode == SandboxMode::kReadOnly) {
        capabilities.push_back(DeriveCapabilitySid(
            std::filesystem::path{request.cwd}, L"read-only"));
    } else {
        capabilities.reserve(request.writable_roots.size());
        for (const auto& root_value : request.writable_roots) {
            const std::filesystem::path root{root_value};
            capabilities.push_back(DeriveCapabilitySid(root, L"workspace-write"));
            GrantWritableRoot(root, capabilities.back().get());
            if (account_sid != nullptr) GrantWritableRoot(root, account_sid);
        }
    }

    const auto denied_paths = ResolveDeniedReadPaths(request);
    for (const auto& capability : capabilities) {
        for (const auto& path : denied_paths) {
            DenyReadPath(path, capability.get());
        }
        for (const auto& root_value : request.writable_roots) {
            const std::filesystem::path root{root_value};
            for (const auto* name : kProtectedMetadata) {
                const auto protected_path = root / name;
                if (std::filesystem::exists(protected_path)) {
                    DenyWritePath(protected_path, capability.get());
                }
            }
        }
    }
    if (account_sid != nullptr) {
        for (const auto& path : denied_paths) DenyReadPath(path, account_sid);
        for (const auto& root_value : request.writable_roots) {
            const std::filesystem::path root{root_value};
            for (const auto* name : kProtectedMetadata) {
                const auto protected_path = root / name;
                if (std::filesystem::exists(protected_path)) {
                    DenyWritePath(protected_path, account_sid);
                }
            }
        }
    }

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

}  // namespace mycli::sandbox
