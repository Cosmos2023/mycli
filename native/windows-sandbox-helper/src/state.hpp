#pragma once

#include <filesystem>
#include <memory>
#include <string>
#include <vector>
#include "win32.hpp"

namespace mycli::sandbox {

class SetupStateLock {
  public:
    explicit SetupStateLock(const std::wstring& owner_sid);
    ~SetupStateLock();
    SetupStateLock(const SetupStateLock&) = delete;
    SetupStateLock& operator=(const SetupStateLock&) = delete;
  private:
    UniqueHandle handle_;
};

// The legacy ACL backend edits host ACEs shared by every journalled command, so
// concurrent peers must carry the same policy. PSEC enforces its policy inside
// the kernel for one process, so divergent peers run independently.
enum class PolicyCoordination { kExclusive, kShared };

// Call only under SetupStateLock, in the unprivileged owner process. Never replay
// caller-controlled journal paths inside an elevated maintenance process.
class AclJournal {
  public:
    explicit AclJournal(const std::filesystem::path& directory);
    ~AclJournal();
    AclJournal(const AclJournal&) = delete;
    AclJournal& operator=(const AclJournal&) = delete;
    void Begin(const std::vector<std::wstring>& denied_paths,
        const std::vector<std::wstring>& policy_scope = {},
        PolicyCoordination coordination = PolicyCoordination::kExclusive);
    void End();
    void Record(const std::filesystem::path& path, PSID sid);
    void RecordDirectory(const std::filesystem::path& path);
    void RecordTemporaryDirectory(const std::filesystem::path& path);
    void Cleanup();
    void StopHelpers();
    bool HasActiveHelpers();
  private:
    struct State;
    std::unique_ptr<State> state_;
};

void RecordSandboxAcl(const std::filesystem::path& path, PSID sid);
void RecordSandboxDirectory(const std::filesystem::path& path);
void RecordSandboxTemporaryDirectory(const std::filesystem::path& path);

}  // namespace mycli::sandbox
