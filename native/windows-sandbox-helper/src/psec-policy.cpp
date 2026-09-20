#include "psec-policy.hpp"

#include <shlobj.h>

#include <algorithm>
#include <cwctype>
#include <filesystem>
#include <set>

#include "identity.hpp"
#include "path-guard.hpp"
#include "process.hpp"
#include "psec-paths.hpp"
#include "psec-request-paths.hpp"

namespace mycli::sandbox {
namespace {

std::wstring Key(const std::wstring& path) {
    auto result = std::filesystem::path{path}.lexically_normal().wstring();
    while (result.size() > 3 && result.back() == L'\\') result.pop_back();
    std::transform(result.begin(), result.end(), result.begin(), [](wchar_t c) { return std::towlower(c); });
    return result;
}

std::wstring Environment(const wchar_t* name) {
    const DWORD count = GetEnvironmentVariableW(name, nullptr, 0);
    if (count == 0) return {};
    std::vector<wchar_t> buffer(count);
    const DWORD length = GetEnvironmentVariableW(name, buffer.data(), count);
    if (length == 0 || length >= count) throw Win32Error("read PSEC environment");
    return {buffer.data(), length};
}

void AppendExisting(std::vector<std::wstring>& paths, const std::filesystem::path& path) {
    std::error_code error;
    const auto canonical = std::filesystem::canonical(path, error);
    if (!error && canonical.is_absolute()) paths.push_back(canonical.wstring());
}

void AddPlatformReads(std::vector<std::wstring>& paths) {
    wchar_t windows[32768]{};
    if (GetWindowsDirectoryW(windows, 32768) == 0) throw Win32Error("resolve Windows directory");
    paths.emplace_back(windows);
    for (const auto* folder : {&FOLDERID_ProgramFiles, &FOLDERID_ProgramFilesX86, &FOLDERID_ProgramData}) {
        PWSTR raw = nullptr;
        const HRESULT result = SHGetKnownFolderPath(*folder, KF_FLAG_DEFAULT, nullptr, &raw);
        if (SUCCEEDED(result) && raw != nullptr) AppendExisting(paths, raw);
        CoTaskMemFree(raw);
    }
    const auto path = Environment(L"PATH");
    for (std::size_t start = 0; start < path.size();) {
        const auto end = path.find(L';', start);
        auto entry = path.substr(start, end == std::wstring::npos ? end : end - start);
        if (entry.size() >= 2 && entry.front() == L'"' && entry.back() == L'"') {
            entry = entry.substr(1, entry.size() - 2);
        }
        if (!entry.empty() && std::filesystem::path{entry}.is_absolute()) AppendExisting(paths, entry);
        if (end == std::wstring::npos) break;
        start = end + 1;
    }
}

void Deduplicate(std::vector<std::wstring>& paths) {
    std::set<std::wstring> seen;
    std::erase_if(paths, [&](const auto& path) { return !seen.insert(Key(path)).second; });
}

void AddVolumeGrants(std::vector<std::wstring>& paths) {
    const DWORD count = GetLogicalDriveStringsW(0, nullptr);
    if (count == 0) throw Win32Error("enumerate PSEC volumes");
    std::vector<wchar_t> volumes(count + 1);
    if (GetLogicalDriveStringsW(static_cast<DWORD>(volumes.size()), volumes.data()) == 0) {
        throw Win32Error("enumerate PSEC volumes");
    }
    std::vector<std::wstring> roots;
    for (const wchar_t* root = volumes.data(); *root; root += wcslen(root) + 1) {
        const auto type = GetDriveTypeW(root);
        if (type != DRIVE_FIXED && type != DRIVE_REMOVABLE && type != DRIVE_REMOTE) continue;
        roots.emplace_back(root);
    }
    const auto grants = SnapshotPsecVolumeRoots(roots);
    paths.insert(paths.end(), grants.begin(), grants.end());
}

bool Within(const std::wstring& path, const std::wstring& root) {
    const auto child = Key(path);
    auto parent = Key(root);
    if (child == parent) return true;
    if (parent.back() != L'\\') parent += L'\\';
    return child.starts_with(parent);
}

bool ProtectedMetadata(const std::wstring& path) {
    for (const auto& component : std::filesystem::path{Key(path)}) {
        if (component == L".git" || component == L".agents" || component == L".codex") return true;
    }
    return false;
}

std::wstring PowerShellLiteral(const std::wstring& value) {
    std::wstring quoted = L"'";
    for (const auto c : value) quoted += c == L'\'' ? L"''" : std::wstring(1, c);
    return quoted + L"'";
}

std::vector<std::wstring> CommandForPsec(const SandboxRequest& request) {
    auto argv = request.command_argv;
    const auto executable = Key(std::filesystem::path{argv.front()}.filename().wstring());
    if (executable != L"powershell.exe" && executable != L"powershell" &&
        executable != L"pwsh.exe" && executable != L"pwsh") return argv;
    if (argv.size() < 3 || Key(argv[argv.size() - 2]) != L"-command") return argv;
    auto root = std::filesystem::path{request.cwd};
    for (const auto& workspace : request.workspace_roots) {
        if (Within(request.cwd, workspace)) { root = workspace; break; }
    }
    const auto relative = std::filesystem::path{request.cwd}.lexically_relative(root);
    const auto location = L"MycliWorkspace:\\" + (relative == L"." ? L"" : relative.wstring());
    // Windows PowerShell normalizes the startup cwd through unreadable parents.
    // A provider drive rooted at the workspace avoids granting those parents.
    argv.back() = L"New-PSDrive -Name MycliWorkspace -PSProvider FileSystem -Root " +
        PowerShellLiteral(root.wstring()) + L" -ErrorAction Stop | Out-Null; " +
        L"Set-Location -LiteralPath " + PowerShellLiteral(location) + L" -ErrorAction Stop; " + argv.back();
    return argv;
}

}  // namespace

std::vector<std::wstring> SnapshotPsecVolumeRoots(const std::vector<std::wstring>& roots) {
    std::vector<std::wstring> paths;
    for (const auto& root : roots) {
        std::error_code error;
        const auto entries = std::filesystem::directory_iterator{root,
            std::filesystem::directory_options::skip_permission_denied, error};
        if (error) continue;
        paths.emplace_back(root);
        for (const auto& entry : entries) {
            const DWORD attributes = GetFileAttributesW(entry.path().c_str());
            if (attributes == INVALID_FILE_ATTRIBUTES) continue;
            auto target = entry.path();
            if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
                // Generated grants may be skipped when their targets cannot be
                // resolved. Explicit request paths instead fail closed.
                SandboxRequest candidate{};
                candidate.cwd = target.wstring();
                try {
                    const PsecRequestPaths pinned{candidate};
                    target = candidate.cwd;
                } catch (const std::exception&) { continue; }
            }
            const UniqueHandle readable{CreateFileW(target.c_str(), FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
            if (!readable) {
                if (GetLastError() == ERROR_ACCESS_DENIED || GetLastError() == ERROR_SHARING_VIOLATION) continue;
                throw Win32Error("inspect PSEC volume entry");
            }
            paths.push_back(target.wstring());
        }
    }
    Deduplicate(paths);
    return paths;
}

PsecPolicy ResolvePsecPolicy(const SandboxRequest& request) {
    if (!request.denied_read_globs.empty()) throw std::runtime_error("runtime must resolve denied-read globs");
    PsecPolicy policy;
    policy.network_enabled = request.network == NetworkPolicy::kEnabled;
    policy.proxy_port = request.network_proxy_port;
    policy.allow_local_binding = request.allow_local_binding;
    policy.network_egress = request.network_egress;
    policy.unrestricted_filesystem = request.filesystem == FilesystemPolicy::kUnrestricted;
    policy.read_roots = request.workspace_roots;
    policy.read_roots.insert(policy.read_roots.end(), request.readable_roots.begin(), request.readable_roots.end());
    if (request.mode == SandboxMode::kWorkspaceWrite) policy.write_roots = request.writable_roots;
    if (policy.unrestricted_filesystem) {
        AddVolumeGrants(policy.write_roots);
        policy.write_roots.insert(policy.write_roots.end(), request.writable_roots.begin(), request.writable_roots.end());
    }
    std::erase_if(policy.write_roots, ProtectedMetadata);
    policy.denied_roots = request.denied_read_roots;
    auto metadata_roots = request.workspace_roots;
    metadata_roots.insert(metadata_roots.end(), request.writable_roots.begin(), request.writable_roots.end());
    for (const auto& value : metadata_roots) {
        const std::filesystem::path root{value};
        const PathGuard guard{root};
        if (!std::filesystem::is_directory(root)) continue;
        for (const auto* name : {L".git", L".agents", L".codex"}) {
            const auto path = root / name;
            const DWORD attributes = GetFileAttributesW(path.c_str());
            if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
                throw std::runtime_error("protected metadata must not be a reparse point");
            }
            policy.read_roots.push_back(path.wstring());
            policy.protected_roots.push_back(path.wstring());
        }
    }
    AddPlatformReads(policy.read_roots);
    policy.protected_roots.insert(policy.protected_roots.end(), request.readonly_roots.begin(), request.readonly_roots.end());
    policy.read_roots.insert(policy.read_roots.end(), request.readonly_roots.begin(), request.readonly_roots.end());
    const std::filesystem::path executable{request.command_argv.front()};
    if (executable.is_absolute()) AppendExisting(policy.read_roots, executable.parent_path());
    const auto state = SandboxStateDirectory();
    if (std::filesystem::exists(state)) policy.denied_roots.push_back(state.wstring());
    Deduplicate(policy.read_roots);
    Deduplicate(policy.write_roots);
    Deduplicate(policy.denied_roots);
    // More specific grants must never override a denied subtree or protected metadata.
    const auto denied = [&](const auto& root) {
        return std::any_of(policy.denied_roots.begin(), policy.denied_roots.end(),
            [&](const auto& deny) { return Within(root, deny); });
    };
    std::erase_if(policy.write_roots, denied);
    std::erase_if(policy.write_roots, [&](const auto& root) {
        return std::any_of(policy.protected_roots.begin(), policy.protected_roots.end(),
            [&](const auto& readonly) { return Within(root, readonly); });
    });
    std::set<std::wstring> protected_paths;
    for (const auto& root : policy.protected_roots) protected_paths.insert(Key(root));
    std::erase_if(policy.read_roots, [&](const auto& root) {
        return denied(root) || (!protected_paths.contains(Key(root)) &&
            std::any_of(policy.write_roots.begin(), policy.write_roots.end(),
                [&](const auto& write) { return Within(root, write); }));
    });
    return policy;
}

DWORD RunPsecRequest(const SandboxRequest& request) {
    auto resolved = request;
    const PsecRequestPaths paths{resolved};
    return RunPsecRequest(resolved, PreparePsecPolicy(resolved));
}

PsecPolicy PreparePsecPolicy(const SandboxRequest& request) {
    auto policy = ResolvePsecPolicy(request);
    PreparePsecPaths(policy);
    if (request.writable_tmp) {
        policy.temporary_directory = CreatePsecTemporaryDirectory();
        for (const auto* restricted : {&policy.denied_roots, &policy.protected_roots}) {
            if (std::any_of(restricted->begin(), restricted->end(), [&](const auto& root) {
                    return Within(policy.temporary_directory, root);
                })) throw std::runtime_error("sandbox temporary directory conflicts with a filesystem restriction");
        }
        policy.write_roots.push_back(policy.temporary_directory);
    }
    Deduplicate(policy.read_roots);
    Deduplicate(policy.denied_roots);
    return policy;
}

DWORD RunPsecRequest(const SandboxRequest& request, const PsecPolicy& policy) {
    // Keep policy ancestors pinned until the process tree exits, including parents of
    // absent deny/metadata paths. A concurrent junction replacement must fail closed.
    std::vector<PathGuard> guards;
    std::set<std::wstring> pinned;
    for (const auto* roots : {&policy.read_roots, &policy.write_roots, &policy.denied_roots}) {
        for (const auto& root : *roots) {
            auto existing = std::filesystem::path{root};
            while (!std::filesystem::exists(existing) && existing.has_relative_path()) {
                existing = existing.parent_path();
            }
            if (pinned.insert(Key(existing.wstring())).second) guards.emplace_back(existing);
        }
    }
    const PsecEnvironment environment{BuildPsecSpecification(policy)};
    if (!policy.temporary_directory.empty()) {
        for (const auto* key : {L"TEMP", L"TMP", L"TMPDIR"}) {
            if (SetEnvironmentVariableW(key, policy.temporary_directory.c_str()) == 0) throw Win32Error("configure PSEC temporary directory");
        }
    }
    // Node's JavaScript realpath walks ungranted ancestors. Keep module paths
    // lexical; PSEC still checks the resolved target on every filesystem open.
    if (SetEnvironmentVariableW(L"NODE_OPTIONS", L"--preserve-symlinks --preserve-symlinks-main") == 0) {
        throw Win32Error("configure PSEC Node module resolution");
    }
    return RunPsecProcessInJob(environment.get(), CommandForPsec(request), request.cwd);
}

}  // namespace mycli::sandbox
