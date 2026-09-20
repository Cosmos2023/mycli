#include "psec-request-paths.hpp"

#include <algorithm>
#include <cwctype>

namespace mycli::sandbox {
namespace {

std::filesystem::path LocalPath(const std::filesystem::path& path) {
    auto text = path.wstring();
    if (text.starts_with(L"\\\\?\\") || text.starts_with(L"\\??\\")) text.erase(0, 4);
    const auto normalized = std::filesystem::path{text}.lexically_normal();
    const auto drive = normalized.root_name().wstring();
    if (!normalized.is_absolute() || drive.size() != 2 || drive[1] != L':' ||
        std::towupper(drive[0]) < L'A' || std::towupper(drive[0]) > L'Z') {
        throw std::runtime_error("PSEC policy path must resolve to a local absolute drive");
    }
    return normalized;
}

std::wstring Key(const std::filesystem::path& path) {
    auto key = path.wstring();
    std::transform(key.begin(), key.end(), key.begin(), [](wchar_t c) { return std::towlower(c); });
    return key;
}

std::filesystem::path OpenedPath(HANDLE handle) {
    std::vector<wchar_t> buffer(32768);
    const DWORD length = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()),
        FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (length == 0 || length >= buffer.size()) throw Win32Error("resolve pinned PSEC request path");
    return LocalPath(std::wstring{buffer.data(), length});
}

}  // namespace

PsecRequestPaths::PsecRequestPaths(SandboxRequest& request) {
    request.cwd = Resolve(request.cwd, false).wstring();
    for (auto* roots : {&request.workspace_roots, &request.writable_roots, &request.readable_roots,
            &request.readonly_roots, &request.denied_read_roots}) {
        const bool allow_missing = roots == &request.readonly_roots || roots == &request.denied_read_roots;
        for (auto& root : *roots) root = Resolve(root, allow_missing).wstring();
    }
}

std::filesystem::path PsecRequestPaths::Resolve(const std::filesystem::path& path,
    bool allow_missing, unsigned depth) {
    if (depth > 32) throw std::runtime_error("psec_policy_reparse_limit");
    const auto normalized = LocalPath(path);
    std::vector<std::filesystem::path> components{normalized.root_path()};
    for (const auto& component : normalized.relative_path()) {
        if (component != L"." && !component.empty()) components.push_back(component);
    }
    std::filesystem::path current;
    for (auto component = components.begin(); component != components.end(); ++component) {
        current /= *component;
        const auto key = Key(current);
        if (const auto found = resolved_.find(key); found != resolved_.end()) {
            current = found->second;
            continue;
        }
        if (handles_.size() >= 16384) throw std::runtime_error("psec_policy_path_handle_limit");
        const DWORD attributes = GetFileAttributesW(current.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES) {
            const DWORD error = GetLastError();
            if (allow_missing && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)) {
                // The existing parent is pinned; preparation will reserve this tail.
                while (++component != components.end()) current /= *component;
                return current;
            }
            throw Win32Error("inspect PSEC request path");
        }
        const bool mutable_file = (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0;
        UniqueHandle handle{CreateFileW(current.c_str(), FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ | (mutable_file ? FILE_SHARE_WRITE : 0), nullptr, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
        if (!handle) throw Win32Error("pin PSEC request path");
        FILE_ATTRIBUTE_TAG_INFO actual{};
        if (!GetFileInformationByHandleEx(handle.get(), FileAttributeTagInfo, &actual, sizeof(actual))) {
            throw Win32Error("inspect pinned PSEC request path");
        }
        if (((actual.FileAttributes ^ attributes) & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
            throw std::runtime_error("psec_policy_path_changed");
        }
        auto resolved = OpenedPath(handle.get());
        handles_.push_back(std::move(handle));
        if ((actual.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
            if (actual.ReparseTag != IO_REPARSE_TAG_MOUNT_POINT && actual.ReparseTag != IO_REPARSE_TAG_SYMLINK) {
                throw std::runtime_error("psec_policy_unsupported_reparse_point");
            }
            // No WRITE/DELETE sharing on the link: its payload and name cannot
            // change while resolving the next hop or executing the command.
            const auto target = std::filesystem::read_symlink(current);
            resolved = Resolve(target.is_relative() ? current.parent_path() / target : target, allow_missing, depth + 1);
        }
        resolved_.emplace(key, resolved);
        current = std::move(resolved);
    }
    return current;
}

}  // namespace mycli::sandbox
