#pragma once
#include <filesystem>
#include <vector>
#include "sid.hpp"
namespace mycli::sandbox {
enum class PublicWriteAuditStatus { kComplete, kNullDacl };

struct PublicWriteAuditTarget {
    std::filesystem::path path;
    bool inherit;
};

struct PublicWriteAudit {
    PublicWriteAuditStatus status = PublicWriteAuditStatus::kComplete;
    std::size_t inspected = 0;
    std::size_t uninspectable = 0;
    bool truncated = false;
    std::vector<PublicWriteAuditTarget> targets;
};

const char* PublicWriteAuditCode(PublicWriteAuditStatus status);
PublicWriteAudit InspectPublicWritePaths(const std::vector<std::filesystem::path>& scan_roots,
    const std::vector<std::wstring>& writable_roots);
PublicWriteAudit InspectHostPublicWritePaths(const std::filesystem::path& cwd,
    const std::vector<std::wstring>& writable_roots);
void ApplyPublicWriteAudit(const PublicWriteAudit& audit, const std::vector<LocalSid>& capabilities);
void AuditPublicWritablePaths(const std::filesystem::path& cwd,
    const std::vector<std::wstring>& writable_roots, const std::vector<LocalSid>& capabilities);
}
