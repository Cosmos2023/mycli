#pragma once
#include <filesystem>
#include <vector>
#include "sid.hpp"
namespace mycli::sandbox {
void AuditPublicWritablePaths(const std::filesystem::path& cwd,
    const std::vector<std::wstring>& writable_roots, const std::vector<LocalSid>& capabilities);
}
