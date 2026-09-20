#include "state.hpp"

#include <algorithm>
#include <fstream>
#include <set>
#include <cwctype>
#include <nlohmann/json.hpp>
#include <sddl.h>
#include "acl.hpp"
#include "path-guard.hpp"
#include "sid.hpp"

namespace mycli::sandbox {
namespace {
using Json = nlohmann::json;
AclJournal* active_journal = nullptr;
constexpr std::uintmax_t kMaxStateBytes = 16 * 1024 * 1024;
constexpr std::size_t kMaxEntries = 50000;

std::string PathString(const std::filesystem::path& path) {
    const auto text = path.u8string();
    return {reinterpret_cast<const char*>(text.data()), text.size()};
}

std::filesystem::path StatePath(const Json& value) {
    const auto text = value.get<std::string>();
    if (text.size() > 32768 || text.find('\0') != std::string::npos) {
        throw std::runtime_error("invalid sandbox journal path");
    }
    return std::filesystem::path{std::u8string{reinterpret_cast<const char8_t*>(text.data()), text.size()}};
}

std::string SidString(PSID sid) {
    LPSTR raw = nullptr;
    if (ConvertSidToStringSidA(sid, &raw) == 0) throw Win32Error("serialize sandbox SID");
    std::string text{raw};
    LocalFree(raw);
    return text;
}

std::uint64_t CreationTime(HANDLE process) {
    FILETIME created{}, exited{}, kernel{}, user{};
    if (GetProcessTimes(process, &created, &exited, &kernel, &user) == 0) {
        throw Win32Error("GetProcessTimes(sandbox helper)");
    }
    return (static_cast<std::uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
}

UniqueHandle ActiveProcess(const Json& lease, DWORD access = 0) {
    const auto pid = lease.at("pid").get<DWORD>();
    UniqueHandle process{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | access, FALSE, pid)};
    if (!process) {
        if (GetLastError() == ERROR_INVALID_PARAMETER) return {};
        throw Win32Error("inspect active sandbox helper");
    }
    if (CreationTime(process.get()) != lease.at("created").get<std::uint64_t>() ||
        WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0) return {};
    return process;
}

void RemoveTemporaryTree(const std::filesystem::path& path, std::size_t& remaining, unsigned depth = 0) {
    if (remaining == 0 || depth > 128) throw std::runtime_error("sandbox temporary cleanup exceeds safety limit");
    --remaining;
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        if (GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND) return;
        throw Win32Error("inspect sandbox temporary path");
    }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
        if (DeleteFileW(path.c_str()) == 0) throw Win32Error("remove sandbox temporary file");
        return;
    }
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) {
        const PathGuard guard{path};
        for (const auto& entry : std::filesystem::directory_iterator{path}) RemoveTemporaryTree(entry.path(), remaining, depth + 1);
    }
    if (RemoveDirectoryW(path.c_str()) == 0) throw Win32Error("remove sandbox temporary directory");
}

bool Overlaps(std::wstring left, std::wstring right) {
    const auto normalize = [](std::wstring value) {
        value = std::filesystem::path{value}.lexically_normal().wstring();
        while (value.size() > 3 && value.back() == L'\\') value.pop_back();
        std::transform(value.begin(), value.end(), value.begin(), [](wchar_t c) { return std::towlower(c); });
        if (value.back() != L'\\') value += L'\\';
        return value;
    };
    left = normalize(std::move(left));
    right = normalize(std::move(right));
    return left.starts_with(right) || right.starts_with(left);
}

bool IndependentPsecPolicies(const Json& left, const Json& right) {
    const auto contains = [](const Json& scope, const char* item) {
        return std::find(scope.begin(), scope.end(), item) != scope.end();
    };
    if (!contains(left, "psec") || !contains(right, "psec") || contains(left, "full") || contains(right, "full")) return false;
    const auto conflicts = [](const Json& writer, const Json& reader) {
        for (const auto& value : writer) {
            const auto entry = StatePath(value).wstring();
            if (!entry.starts_with(L"write:")) continue;
            for (const auto& other : reader) {
                const auto target = StatePath(other).wstring();
                const auto separator = target.find(L':');
                if (separator != std::wstring::npos && Overlaps(entry.substr(6), target.substr(separator + 1))) return true;
            }
        }
        return false;
    };
    return !conflicts(left, right) && !conflicts(right, left);
}

bool CompatiblePsecReader(const Json& reader, const Json& writer) {
    std::set<std::wstring> read_scope, write_scope;
    std::vector<std::wstring> readable, writable;
    for (const auto& value : reader) {
        const auto entry = StatePath(value).wstring();
        if (entry == L"full" || entry.starts_with(L"write:")) return false;
        read_scope.insert(entry);
        if (entry.starts_with(L"read:")) readable.push_back(entry.substr(5));
    }
    if (!read_scope.contains(L"psec")) return false;
    for (const auto& value : writer) {
        const auto entry = StatePath(value).wstring();
        if (entry.starts_with(L"write:")) writable.push_back(entry.substr(6));
        else write_scope.insert(entry);
    }
    if (read_scope != write_scope) return false;
    // A reader has no writable namespace in which an alias can increase write authority.
    // Every possible hardlink source of the writer must already be readable by the reader.
    return std::all_of(writable.begin(), writable.end(), [&](const auto& path) {
        return std::any_of(readable.begin(), readable.end(), [&](const auto& root) {
            const auto parent = std::filesystem::path{root}.lexically_normal();
            const auto relative = std::filesystem::path{path}.lexically_normal().lexically_relative(parent);
            if (relative == L".") return true;
            // PSEC volume-root grants do not include their descendants.
            return parent.has_relative_path() && !relative.empty() && *relative.begin() != L"..";
        });
    });
}
}  // namespace

SetupStateLock::SetupStateLock(const std::wstring& owner_sid)
    : handle_{CreateMutexW(nullptr, FALSE,
          (L"Global\\mycli-windows-sandbox-setup-" + owner_sid).c_str())} {
    if (!handle_) throw Win32Error("CreateMutexW(sandbox setup)");
    const DWORD result = WaitForSingleObject(handle_.get(), 300000);
    if (result != WAIT_OBJECT_0 && result != WAIT_ABANDONED) {
        throw std::runtime_error("sandbox maintenance lock timed out");
    }
}

SetupStateLock::~SetupStateLock() { ReleaseMutex(handle_.get()); }

struct AclJournal::State {
    std::filesystem::path directory;
    PathGuard guard;
    Json data;
    std::set<std::pair<std::string, std::string>> recorded;

    explicit State(const std::filesystem::path& root) : directory{root}, guard{root} {
        const auto path = directory / L"acl-state.v1.json";
        data = {{"version", 1}, {"entries", Json::array()}, {"directories", Json::array()},
            {"leases", Json::array()}, {"denied_paths", Json::array()}};
        if (std::filesystem::exists(path)) {
            const PathGuard file{path};
            if (std::filesystem::file_size(path) > kMaxStateBytes) {
                throw std::runtime_error("sandbox journal exceeds size limit");
            }
            std::ifstream input{path, std::ios::binary};
            data = Json::parse(input);
        }
        if (data.at("version") != 1) throw std::runtime_error("unsupported sandbox journal version");
        for (const auto* key : {"entries", "directories", "leases", "denied_paths"}) {
            if (!data.at(key).is_array() || data.at(key).size() > kMaxEntries) {
                throw std::runtime_error("invalid sandbox journal collection");
            }
        }
        for (const auto& entry : data.at("entries")) {
            recorded.emplace(entry.at("path").get<std::string>(), entry.at("sid").get<std::string>());
        }
        if (!data.contains("temporary_directories")) data["temporary_directories"] = Json::array();
        if (!data.at("temporary_directories").is_array() || data.at("temporary_directories").size() > kMaxEntries) {
            throw std::runtime_error("invalid sandbox temporary journal");
        }
    }

    void Save() const {
        const auto bytes = data.dump();
        if (bytes.size() > kMaxStateBytes) throw std::runtime_error("sandbox journal exceeds size limit");
        const auto temporary = directory / L"acl-state.v1.tmp";
        // State directory is owner-only and pinned; remove a stale name, never follow it.
        if (DeleteFileW(temporary.c_str()) == 0 && GetLastError() != ERROR_FILE_NOT_FOUND) {
            throw Win32Error("remove stale sandbox journal temporary");
        }
        {
            const UniqueHandle file{CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr,
                CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
            if (!file) throw Win32Error("create sandbox journal");
            DWORD written = 0;
            if (WriteFile(file.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) == 0 ||
                written != bytes.size() || FlushFileBuffers(file.get()) == 0) {
                throw Win32Error("persist sandbox journal");
            }
        }
        if (MoveFileExW(temporary.c_str(), (directory / L"acl-state.v1.json").c_str(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) == 0) {
            throw Win32Error("replace sandbox journal");
        }
    }

    void Prune() {
        auto& leases = data.at("leases");
        for (auto it = leases.begin(); it != leases.end();) {
            if (!ActiveProcess(*it)) it = leases.erase(it);
            else ++it;
        }
    }
};

AclJournal::AclJournal(const std::filesystem::path& directory)
    : state_{std::make_unique<State>(directory)} {
    if (active_journal != nullptr) throw std::runtime_error("nested sandbox journal");
    active_journal = this;
}
AclJournal::~AclJournal() { active_journal = nullptr; }

bool AclJournal::HasActiveHelpers() {
    state_->Prune();
    return !state_->data.at("leases").empty();
}

void AclJournal::Begin(const std::vector<std::wstring>& denied_paths,
    const std::vector<std::wstring>& policy_scope,
    PolicyCoordination coordination) {
    std::set<std::string> paths;
    for (const auto& path : denied_paths) paths.insert(PathString(path));
    const Json policy = paths;
    std::set<std::string> scope_paths;
    for (const auto& path : policy_scope) scope_paths.insert(PathString(path));
    const Json scope = scope_paths;
    if (HasActiveHelpers()) {
        if (coordination == PolicyCoordination::kExclusive) {
            for (const auto& lease : state_->data.at("leases")) {
                const auto other_policy = lease.value("denied_paths", state_->data.at("denied_paths"));
                const auto other_scope = lease.value("policy_scope", state_->data.value("policy_scope", Json::array()));
                if (other_policy == policy && other_scope == scope) continue;
                if (IndependentPsecPolicies(scope, other_scope)) continue;
                if (other_policy == policy && (CompatiblePsecReader(scope, other_scope) ||
                        CompatiblePsecReader(other_scope, scope))) continue;
                if (other_policy != policy) {
                    throw std::runtime_error("denied-read policy changed while sandbox commands are active; stop them before retrying");
                }
                throw std::runtime_error("filesystem policy changed while sandbox commands are active; stop them before retrying");
            }
        }
    } else {
        Cleanup();
    }
    state_->data["denied_paths"] = policy;
    state_->data["policy_scope"] = scope;
    state_->data["leases"].push_back({{"pid", GetCurrentProcessId()},
        {"created", CreationTime(GetCurrentProcess())}, {"denied_paths", policy}, {"policy_scope", scope},
        {"coordination", coordination == PolicyCoordination::kShared ? "shared" : "exclusive"}});
    state_->Save();
}

void AclJournal::Record(const std::filesystem::path& path, PSID sid) {
    const auto entry = std::make_pair(PathString(path), SidString(sid));
    if (state_->recorded.contains(entry)) return;
    if (state_->recorded.size() >= kMaxEntries) throw std::runtime_error("sandbox ACL journal is full");
    state_->data["entries"].push_back({{"path", entry.first}, {"sid", entry.second}});
    state_->Save();  // Write-ahead: cleanup remains possible after a crash in the ACL update.
    state_->recorded.insert(entry);
}

void AclJournal::End() {
    auto& leases = state_->data.at("leases");
    for (auto it = leases.begin(); it != leases.end();) {
        if (it->at("pid").get<DWORD>() == GetCurrentProcessId()) it = leases.erase(it);
        else ++it;
    }
    state_->Save();
    if (!HasActiveHelpers()) Cleanup();
}

void AclJournal::RecordDirectory(const std::filesystem::path& path) {
    state_->data["directories"].push_back(PathString(path));
    state_->Save();
}

void AclJournal::RecordTemporaryDirectory(const std::filesystem::path& path) {
    state_->data["temporary_directories"].push_back(PathString(path));
    state_->Save();
}

void AclJournal::Cleanup() {
    if (HasActiveHelpers()) throw std::runtime_error("sandbox commands are still active");
    auto& entries = state_->data.at("entries");
    while (!entries.empty()) {
        const auto& entry = entries.back();
        const auto path = StatePath(entry.at("path"));
        const auto sid_text = entry.at("sid").get<std::string>();
        const auto sid = SidFromString(std::wstring{sid_text.begin(), sid_text.end()});
        if (std::filesystem::exists(path)) RevokeSandboxAccess(path, sid.get());
        entries.erase(entries.size() - 1);
        state_->Save();
    }
    auto& directories = state_->data.at("directories");
    while (!directories.empty()) {
        const auto path = StatePath(directories.back());
        if (std::filesystem::exists(path)) {
            const PathGuard parent{path.parent_path()};
            const DWORD attributes = GetFileAttributesW(path.c_str());
            if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
                throw std::runtime_error("sandbox placeholder became a reparse point");
            }
            // Only remove empty placeholders; never recursively remove user data.
            if (RemoveDirectoryW(path.c_str()) == 0 && GetLastError() != ERROR_DIR_NOT_EMPTY) {
                throw Win32Error("remove sandbox placeholder");
            }
        }
        directories.erase(directories.size() - 1);
        state_->Save();
    }
    state_->recorded.clear();
    auto& temporary = state_->data.at("temporary_directories");
    while (!temporary.empty()) {
        const auto path = StatePath(temporary.back());
        const auto root = state_->directory.parent_path() / L"sandbox-tmp";
        const auto name = path.filename().wstring();
        bool valid_name = name.size() == 38;
        for (std::size_t index = 0; valid_name && index < name.size(); ++index) {
            if (index == 0) valid_name = name[index] == L'{';
            else if (index == 37) valid_name = name[index] == L'}';
            else if (index == 9 || index == 14 || index == 19 || index == 24) valid_name = name[index] == L'-';
            else valid_name = (name[index] >= L'0' && name[index] <= L'9') ||
                (name[index] >= L'A' && name[index] <= L'F') || (name[index] >= L'a' && name[index] <= L'f');
        }
        if (path.parent_path() != root || !valid_name) {
            throw std::runtime_error("invalid sandbox temporary cleanup path");
        }
        const PathGuard parent{root};
        std::size_t remaining = 100000;
        RemoveTemporaryTree(path, remaining);
        temporary.erase(temporary.size() - 1);
        state_->Save();
    }
    state_->data["denied_paths"] = Json::array();
    state_->Save();
}

void AclJournal::StopHelpers() {
    state_->Prune();
    for (const auto& lease : state_->data.at("leases")) {
        if (lease.at("pid").get<DWORD>() == GetCurrentProcessId()) {
            throw std::runtime_error("maintenance cannot stop itself");
        }
        auto process = ActiveProcess(lease, PROCESS_TERMINATE);
        if (!process) continue;
        if (TerminateProcess(process.get(), 1) == 0 ||
            WaitForSingleObject(process.get(), 10000) != WAIT_OBJECT_0) {
            throw Win32Error("stop sandbox helper for maintenance");
        }
    }
    state_->Prune();
    state_->Save();
}

void RecordSandboxAcl(const std::filesystem::path& path, PSID sid) {
    if (active_journal != nullptr) active_journal->Record(path, sid);
}
void RecordSandboxDirectory(const std::filesystem::path& path) {
    if (active_journal != nullptr) active_journal->RecordDirectory(path);
}
void RecordSandboxTemporaryDirectory(const std::filesystem::path& path) {
    if (active_journal != nullptr) active_journal->RecordTemporaryDirectory(path);
}
}  // namespace mycli::sandbox
