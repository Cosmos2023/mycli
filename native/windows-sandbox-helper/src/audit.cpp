#include "audit.hpp"
#include <aclapi.h>
#include <algorithm>
#include <chrono>
#include <cwctype>
#include <deque>
#include <set>
#include "acl.hpp"
#include "path-guard.hpp"

namespace mycli::sandbox {
namespace {
std::wstring Key(const std::filesystem::path& path) {
    auto text = path.lexically_normal().wstring();
    std::transform(text.begin(), text.end(), text.begin(), [](wchar_t c) {
        return static_cast<wchar_t>(std::towlower(c));
    });
    return text;
}

bool Within(const std::filesystem::path& path, const std::filesystem::path& root) {
    const auto key = Key(path);
    auto parent = Key(root);
    if (key == parent) return true;
    if (!parent.ends_with(L"\\")) parent += L'\\';
    return key.starts_with(parent);
}

std::wstring Environment(const wchar_t* name) {
    const DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
    if (size == 0) return {};
    std::vector<wchar_t> buffer(size);
    const DWORD length = GetEnvironmentVariableW(name, buffer.data(), size);
    if (length == 0 || length >= size) throw Win32Error("read sandbox audit environment");
    return {buffer.data(), length};
}

enum class PathAccess { kNotPubliclyWritable, kPubliclyWritable, kNullDacl };

PathAccess PublicWriteAccess(const std::filesystem::path& path, PSID world) {
    const PathGuard guard{path};
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const DWORD status = GetSecurityInfo(guard.leaf(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &acl, nullptr, &descriptor);
    if (status != ERROR_SUCCESS) {
        SetLastError(status);
        throw Win32Error("read public directory ACL");
    }
    TRUSTEE_W trustee{};
    BuildTrusteeWithSidW(&trustee, world);
    DWORD rights = 0;
    const DWORD result = acl == nullptr ? ERROR_SUCCESS : GetEffectiveRightsFromAclW(acl, &trustee, &rights);
    const bool null_dacl = acl == nullptr;
    const bool writable = (rights & (FILE_WRITE_DATA | FILE_APPEND_DATA |
        FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | DELETE | FILE_DELETE_CHILD | GENERIC_WRITE | GENERIC_ALL)) != 0;
    LocalFree(descriptor);
    if (result != ERROR_SUCCESS) {
        SetLastError(result);
        throw Win32Error("inspect public directory ACL");
    }
    return null_dacl ? PathAccess::kNullDacl
        : writable ? PathAccess::kPubliclyWritable : PathAccess::kNotPubliclyWritable;
}
}  // namespace

const char* PublicWriteAuditCode(PublicWriteAuditStatus status) {
    switch (status) {
        case PublicWriteAuditStatus::kComplete: return "no_known_blocker";
        case PublicWriteAuditStatus::kNullDacl: return "host_null_dacl";
    }
    throw std::runtime_error("invalid host audit status");
}

PublicWriteAudit InspectHostPublicWritePaths(const std::filesystem::path& cwd,
    const std::vector<std::wstring>& writable_roots) {
    std::vector<std::filesystem::path> roots{cwd};
    for (const auto* name : {L"TEMP", L"TMP", L"USERPROFILE", L"PUBLIC", L"SystemRoot", L"ProgramData"}) {
        const auto value = Environment(name);
        if (!value.empty()) roots.emplace_back(value);
    }
    const auto path = Environment(L"PATH");
    for (std::size_t start = 0; start < path.size();) {
        const auto end = path.find(L';', start);
        const auto part = path.substr(start, end == std::wstring::npos ? end : end - start);
        if (!part.empty()) roots.emplace_back(part);
        if (end == std::wstring::npos) break;
        start = end + 1;
    }
    roots.emplace_back(cwd.root_path());
    return InspectPublicWritePaths(roots, writable_roots);
}

PublicWriteAudit InspectPublicWritePaths(const std::vector<std::filesystem::path>& scan_roots,
    const std::vector<std::wstring>& writable_roots) {
    PublicWriteAudit audit;
    std::deque<std::pair<std::filesystem::path, unsigned>> pending;
    for (const auto& path : scan_roots) pending.emplace_back(path, 0);
    const auto world = SidFromString(L"S-1-1-0");
    std::set<std::wstring> seen;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{2};
    // Like Codex, this is a bounded preflight audit, not a whole-volume ACL scan.
    while (!pending.empty()) {
        if (seen.size() >= 50000 || std::chrono::steady_clock::now() >= deadline) {
            audit.truncated = true;
            break;
        }
        auto [candidate, depth] = pending.front();
        pending.pop_front();
        if (!candidate.is_absolute() || !seen.insert(Key(candidate)).second) continue;
        ++audit.inspected;
        const DWORD attributes = GetFileAttributesW(candidate.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) continue;
        const bool allowed = std::any_of(writable_roots.begin(), writable_roots.end(), [&](const auto& root) {
            return Within(candidate, root);
        });
        PathAccess access = PathAccess::kNotPubliclyWritable;
        try {
            if (!allowed) access = PublicWriteAccess(candidate, world.get());
        } catch (const std::exception&) {
            // ACLs the host cannot inspect are outside this best-effort audit.
            ++audit.uninspectable;
            continue;
        }
        if (access == PathAccess::kNullDacl) {
            audit.status = PublicWriteAuditStatus::kNullDacl;
            break;
        }
        if (access == PathAccess::kPubliclyWritable) {
            const bool ancestor = std::any_of(writable_roots.begin(), writable_roots.end(), [&](const auto& root) {
                return Within(root, candidate);
            });
            // Never propagate a deny through an ancestor into an allowed root.
            audit.targets.push_back({candidate, !ancestor});
        }
        if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || depth >= 2) continue;
        std::error_code error;
        std::filesystem::directory_iterator iterator{candidate, error};
        const std::filesystem::directory_iterator end;
        std::size_t count = 0;
        for (; !error && iterator != end && count < 1000; iterator.increment(error), ++count) {
            pending.emplace_back(iterator->path(), depth + 1);
        }
        if (!error && iterator != end) {
            audit.truncated = true;
        }
        if (error) ++audit.uninspectable;
    }
    return audit;
}

void ApplyPublicWriteAudit(const PublicWriteAudit& audit, const std::vector<LocalSid>& capabilities) {
    if (audit.status != PublicWriteAuditStatus::kComplete) {
        throw std::runtime_error(PublicWriteAuditCode(audit.status));
    }
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{2};
    for (const auto& target : audit.targets) {
        for (const auto& capability : capabilities) {
            if (std::chrono::steady_clock::now() >= deadline) {
                throw std::runtime_error("host_audit_apply_timeout");
            }
            DenyWritePath(target.path, capability.get(), target.inherit);
        }
    }
}

void AuditPublicWritablePaths(const std::filesystem::path& cwd,
    const std::vector<std::wstring>& writable_roots, const std::vector<LocalSid>& capabilities) {
    ApplyPublicWriteAudit(InspectHostPublicWritePaths(cwd, writable_roots), capabilities);
}
}  // namespace mycli::sandbox
