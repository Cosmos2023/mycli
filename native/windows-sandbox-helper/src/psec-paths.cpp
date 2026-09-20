#include "psec-paths.hpp"
#include <objbase.h>

#include <algorithm>
#include <cwctype>
#include <filesystem>
#include <functional>
#include <iostream>
#include <set>

#include "path-guard.hpp"
#include "state.hpp"
#include "identity.hpp"

namespace mycli::sandbox {
namespace {
constexpr std::size_t kMaxEntries = 250000;

// Temporary phase profiling for local latency work; enabled with
// MYCLI_SANDBOX_PROFILE=1 and silent otherwise.
class ScanTimer {
public:
    explicit ScanTimer(const char* label) : label_(label) {
        if (GetEnvironmentVariableW(L"MYCLI_SANDBOX_PROFILE", nullptr, 0) == 0) return;
        LARGE_INTEGER counter{};
        QueryPerformanceCounter(&counter);
        start_ = counter.QuadPart;
    }
    ~ScanTimer() {
        if (start_ == 0) return;
        LARGE_INTEGER counter{};
        LARGE_INTEGER frequency{};
        QueryPerformanceCounter(&counter);
        QueryPerformanceFrequency(&frequency);
        const double ms = static_cast<double>(counter.QuadPart - start_) * 1000.0 / static_cast<double>(frequency.QuadPart);
        std::cerr << "[profile] " << label_ << ": " << static_cast<int>(ms) << " ms\n";
    }

private:
    const char* label_;
    long long start_ = 0;
};

std::wstring Key(const std::filesystem::path& path) {
    auto key = path.lexically_normal().wstring();
    while (key.size() > 3 && key.back() == L'\\') key.pop_back();
    std::transform(key.begin(), key.end(), key.begin(), [](wchar_t c) { return std::towlower(c); });
    return key;
}

bool Under(const std::filesystem::path& path, const std::wstring& root) {
    const auto child = Key(path);
    auto parent = Key(root);
    if (child == parent) return true;
    if (parent.back() != L'\\') parent += L'\\';
    return child.starts_with(parent);
}

bool UnderAny(const std::filesystem::path& path, const std::vector<std::wstring>& roots) {
    return std::any_of(roots.begin(), roots.end(), [&](const auto& root) { return Under(path, root); });
}

void Reserve(const std::filesystem::path& path) {
    if (std::filesystem::exists(path)) { const PathGuard guard{path}; return; }
    const auto parent = path.parent_path();
    if (parent == path || parent.empty()) throw std::runtime_error("invalid PSEC protected path");
    Reserve(parent);
    const PathGuard guard{parent};
    if (CreateDirectoryW(path.c_str(), nullptr) == 0) {
        if (GetLastError() != ERROR_ALREADY_EXISTS) throw Win32Error("reserve PSEC protected path");
        const PathGuard existing{path};
    } else {
        RecordSandboxDirectory(path);
    }
}

std::vector<std::wstring> Aliases(const std::filesystem::path& path) {
    if (std::filesystem::hard_link_count(path) < 2) return {};
    std::vector<wchar_t> name(32768);
    DWORD size = static_cast<DWORD>(name.size());
    const HANDLE handle = FindFirstFileNameW(path.c_str(), 0, &size, name.data());
    if (handle == INVALID_HANDLE_VALUE) throw Win32Error("enumerate PSEC hardlink aliases");
    std::vector<std::wstring> paths;
    DWORD error = ERROR_SUCCESS;
    do {
        paths.push_back((path.root_path() / std::filesystem::path{name.data()}.relative_path()).wstring());
        size = static_cast<DWORD>(name.size());
        if (FindNextFileNameW(handle, &size, name.data()) == 0) { error = GetLastError(); break; }
    } while (paths.size() < 1024);
    FindClose(handle);
    if (error != ERROR_HANDLE_EOF) throw std::runtime_error("PSEC hardlink alias enumeration incomplete");
    return paths;
}

void Walk(const std::vector<std::wstring>& roots, const std::function<void(const std::filesystem::path&)>& file,
    bool reject_reparse_points = true) {
    std::vector<std::filesystem::path> pending(roots.begin(), roots.end());
    std::set<std::wstring> visited;
    while (!pending.empty()) {
        auto path = std::move(pending.back());
        pending.pop_back();
        if (!visited.insert(Key(path)).second) continue;
        if (visited.size() > kMaxEntries) throw std::runtime_error("psec_path_scan_limit");
        const auto attributes = GetFileAttributesW(path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES) throw Win32Error("inspect PSEC policy path");
        // PSEC checks the resolved target of junctions/symlinks; do not follow them while scanning.
        if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
            if (reject_reparse_points) throw std::runtime_error("psec_protected_tree_contains_reparse_point");
            continue;
        }
        if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
            for (const auto& entry : std::filesystem::directory_iterator{path}) {
                if (pending.size() + visited.size() >= kMaxEntries) throw std::runtime_error("psec_path_scan_limit");
                pending.push_back(entry.path());
            }
        } else {
            file(path);
        }
    }
}

}  // namespace

void PreparePsecPaths(PsecPolicy& policy) {
    ScanTimer reserve_timer("psec-reserve-protected");
    for (const auto* roots : {&policy.protected_roots, &policy.denied_roots}) {
        for (const auto& path : *roots) Reserve(path);
    }
    std::vector<std::wstring> denied_aliases, protected_aliases;
    {
        ScanTimer denied_timer("psec-walk-denied");
        Walk(policy.denied_roots, [&](const auto& path) {
            const auto aliases = Aliases(path);
            denied_aliases.insert(denied_aliases.end(), aliases.begin(), aliases.end());
        });
    }
    {
        ScanTimer protected_timer("psec-walk-protected");
        Walk(policy.protected_roots, [&](const auto& path) {
            const auto aliases = Aliases(path);
            protected_aliases.insert(protected_aliases.end(), aliases.begin(), aliases.end());
        });
    }
    policy.denied_roots.insert(policy.denied_roots.end(), denied_aliases.begin(), denied_aliases.end());
    policy.protected_roots.insert(policy.protected_roots.end(), protected_aliases.begin(), protected_aliases.end());
    policy.read_roots.insert(policy.read_roots.end(), protected_aliases.begin(), protected_aliases.end());
    std::erase_if(policy.read_roots, [&](const auto& path) { return UnderAny(path, policy.denied_roots); });
    // Writable roots are no longer walked for hardlink aliases. PSEC rejects every
    // link creation inside the sandbox, so only an outside actor can add an alias;
    // accepting that residual matches the shipped Codex Windows sandbox and keeps
    // launch preparation independent of workspace size.
}

std::wstring CreatePsecTemporaryDirectory() {
    const auto root = SandboxStateDirectory().parent_path() / L"sandbox-tmp";
    PrepareSandboxStateDirectory(root, CurrentUserSidString());
    const PathGuard guard{root};
    GUID id{};
    if (FAILED(CoCreateGuid(&id))) throw std::runtime_error("create PSEC temporary identity");
    wchar_t name[40]{};
    if (StringFromGUID2(id, name, 40) == 0) throw std::runtime_error("encode PSEC temporary identity");
    const auto path = root / name;
    RecordSandboxTemporaryDirectory(path);
    if (CreateDirectoryW(path.c_str(), nullptr) == 0) throw Win32Error("create PSEC temporary directory");
    return path.wstring();
}
}  // namespace mycli::sandbox

