#pragma once

#include <filesystem>
#include <map>
#include <vector>
#include "protocol.hpp"
#include "win32.hpp"

namespace mycli::sandbox {

// Resolves explicit PSEC roots and pins their complete link/target chains. Keep
// this owner alive from lease admission until the workload has finished.
class PsecRequestPaths {
  public:
    explicit PsecRequestPaths(SandboxRequest& request);
  private:
    std::filesystem::path Resolve(const std::filesystem::path& path, bool allow_missing, unsigned depth = 0);
    std::vector<UniqueHandle> handles_;
    std::map<std::wstring, std::filesystem::path> resolved_;
};

}  // namespace mycli::sandbox
