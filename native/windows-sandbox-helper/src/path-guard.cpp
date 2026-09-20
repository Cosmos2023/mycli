#include "path-guard.hpp"

namespace mycli::sandbox {

PathGuard::PathGuard(const std::filesystem::path& path, DWORD leaf_access) {
    const auto normalized = path.lexically_normal();
    if (!normalized.is_absolute() || normalized.root_name().wstring().starts_with(L"\\\\")) {
        throw std::runtime_error("sandbox ACL path must be on a local absolute drive");
    }
    auto current = normalized.root_path();
    std::vector<std::filesystem::path> components{current};
    for (const auto& component : normalized.relative_path()) {
        if (component == L".") continue;
        current /= component;
        components.push_back(current);
    }
    for (std::size_t index = 0; index < components.size(); ++index) {
        // Attribute-only handles do not participate in Windows sharing checks.
        // Request data access so omitting FILE_SHARE_DELETE really pins the path.
        const DWORD access = FILE_READ_DATA | FILE_READ_ATTRIBUTES |
            (index + 1 == components.size() ? leaf_access : 0);
        const HANDLE handle = CreateFileW(components[index].c_str(), access,
            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (handle == INVALID_HANDLE_VALUE) throw Win32Error("open sandbox ACL path");
        handles_.emplace_back(handle);
        FILE_ATTRIBUTE_TAG_INFO attributes{};
        if (GetFileInformationByHandleEx(handle, FileAttributeTagInfo,
                &attributes, sizeof(attributes)) == 0) {
            throw Win32Error("inspect sandbox ACL path");
        }
        if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
            throw std::runtime_error("sandbox ACL path crosses a reparse point");
        }
    }
}

}  // namespace mycli::sandbox
