#pragma once

#include <filesystem>
#include <vector>
#include "win32.hpp"

namespace mycli::sandbox {

// Pins every component against rename/reparse replacement during ACL operations.
class PathGuard {
  public:
    explicit PathGuard(const std::filesystem::path& path, DWORD leaf_access = READ_CONTROL);
    [[nodiscard]] HANDLE leaf() const noexcept { return handles_.back().get(); }
  private:
    std::vector<UniqueHandle> handles_;
};

}  // namespace mycli::sandbox
