#include "sandbox.hpp"

#include <windows.h>
#include <sddl.h>

#include <algorithm>
#include <filesystem>
#include <set>
#include <stdexcept>
#include <string_view>
#include <vector>

#include "acl.hpp"
#include "audit.hpp"
#include "path-guard.hpp"
#include "state.hpp"
#include "process.hpp"
#include "identity.hpp"
#include "sid.hpp"
#include "token.hpp"

namespace mycli::sandbox {
namespace {

constexpr const wchar_t* kProtectedMetadata[] = {L".git", L".agents", L".codex"};

bool IsReparsePoint(const std::filesystem::path& path) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

void ReserveDeniedPath(const std::filesystem::path& path) {
    if (std::filesystem::exists(path)) {
        const PathGuard guard{path};
        return;
    }
    const auto parent = path.parent_path();
    if (parent == path || parent.empty()) throw std::runtime_error("invalid denied-read root");
    ReserveDeniedPath(parent);
    const PathGuard guard{parent};
    if (CreateDirectoryW(path.c_str(), nullptr) == 0) {
        // A concurrent creator must never redirect ACL application via a reparse point.
        if (GetLastError() != ERROR_ALREADY_EXISTS) throw Win32Error("reserve denied-read path");
        const PathGuard existing{path};
        return;
    }
    RecordSandboxDirectory(path);
}

std::wstring AccountScope(PSID sid) {
    if (sid == nullptr) return CurrentUserSidString();
    LPWSTR raw = nullptr;
    if (ConvertSidToStringSidW(sid, &raw) == 0) throw Win32Error("serialize capability account SID");
    const std::wstring text{raw};
    LocalFree(raw);
    return text;
}

std::vector<LocalSid> CapabilitiesForRequest(const SandboxRequest& request, const std::wstring& account) {
    std::vector<LocalSid> capabilities;
    if (request.mode == SandboxMode::kReadOnly || request.writable_roots.empty()) {
        capabilities.push_back(DeriveCapabilitySid(
            std::filesystem::path{request.cwd}, L"read-only:" + account));
        return capabilities;
    }
    // Include the entire write policy in the capability scope. Audit denies from
    // a narrower concurrent command must not poison a wider command's capability.
    std::wstring scope = L"workspace-write:" + account;
    auto roots = request.writable_roots;
    std::sort(roots.begin(), roots.end());
    for (const auto& root : roots) scope += L"\n" + root;
    capabilities.reserve(request.writable_roots.size());
    for (const auto& root_value : request.writable_roots) {
        capabilities.push_back(DeriveCapabilitySid(
            std::filesystem::path{root_value}, scope));
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
    if (!request.denied_read_globs.empty()) {
        throw std::runtime_error("denied-read globs must be resolved by the runtime");
    }
    // Detect known host blockers before reserving paths or granting account access.
    const auto capabilities = CapabilitiesForRequest(request, AccountScope(account_sid));
    AuditPublicWritablePaths(request.cwd, request.writable_roots, capabilities);
    std::vector<std::filesystem::path> denied_paths;
    for (const auto& value : request.denied_read_roots) {
        const std::filesystem::path path{value};
        ReserveDeniedPath(path);
        denied_paths.push_back(path);
    }
    if (account_sid != nullptr) {
        for (const auto& root_value : request.workspace_roots) {
            GrantReadableRoot(std::filesystem::path{root_value}, account_sid);
        }
        const std::filesystem::path executable{request.command_argv.front()};
        if (executable.is_absolute() && executable.has_parent_path()) {
            GrantReadableRoot(executable.parent_path(), account_sid);
        }
    }
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
            DenyDeleteChildPath(path.parent_path(), capability.get());
        }
        for (const auto& path : protected_paths) DenyWritePath(path, capability.get());
    }
    if (account_sid != nullptr) {
        for (const auto& path : denied_paths) {
            DenyReadPath(path, account_sid);
            DenyDeleteChildPath(path.parent_path(), account_sid);
        }
        for (const auto& path : protected_paths) DenyWritePath(path, account_sid);
    }
}

DWORD RunPreparedSandboxRequest(const SandboxRequest& request) {
    return RunWithCapabilities(request, nullptr, CapabilitiesForRequest(request, CurrentUserSidString()));
}

DWORD RunSandboxRequest(
    const SandboxRequest& request,
    HANDLE base_token,
    PSID account_sid) {
    PrepareSandboxRequest(request, account_sid);
    return RunWithCapabilities(request, base_token, CapabilitiesForRequest(request, AccountScope(account_sid)));
}

}  // namespace mycli::sandbox
