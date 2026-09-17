#include "maintenance.hpp"
#include <windows.h>
#include <tlhelp32.h>
#include <algorithm>
#include <chrono>
#include "firewall.hpp"
#include "identity.hpp"
#include "wfp.hpp"
#include "win32.hpp"

namespace mycli::sandbox {

void QuiesceSandboxAccounts(const std::filesystem::path& directory, const std::wstring& owner_sid) {
    const auto accounts = OwnedSandboxAccountSids(directory, owner_sid);
    DisableSandboxAccounts(directory, owner_sid);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{30};
    while (true) {
        const UniqueHandle snapshot{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)};
        if (!snapshot) throw Win32Error("enumerate sandbox processes");
        PROCESSENTRY32W entry{};
        entry.dwSize = sizeof(entry);
        if (Process32FirstW(snapshot.get(), &entry) == 0) throw Win32Error("read process snapshot");
        bool found = false;
        do {
            const UniqueHandle process{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                FALSE, entry.th32ProcessID)};
            if (!process) continue;
            HANDLE raw_token = nullptr;
            if (OpenProcessToken(process.get(), TOKEN_QUERY, &raw_token) == 0) continue;
            const UniqueHandle token{raw_token};
            const auto sid = TokenUserSidString(token.get());
            if (std::find(accounts.begin(), accounts.end(), sid) == accounts.end()) continue;
            found = true;
            const UniqueHandle termination{OpenProcess(PROCESS_TERMINATE, FALSE, entry.th32ProcessID)};
            // Keep the first process handle open so this PID cannot be reused.
            if ((!termination || TerminateProcess(termination.get(), 1) == 0) &&
                WaitForSingleObject(process.get(), 0) != WAIT_OBJECT_0) {
                throw Win32Error("terminate sandbox account process");
            }
            if (WaitForSingleObject(process.get(), 10000) != WAIT_OBJECT_0) {
                throw std::runtime_error("sandbox account process did not stop");
            }
        } while (Process32NextW(snapshot.get(), &entry) != 0);
        if (GetLastError() != ERROR_NO_MORE_FILES) throw Win32Error("read process snapshot");
        if (!found) return;
        if (std::chrono::steady_clock::now() >= deadline) {
            throw std::runtime_error("sandbox account process cleanup timed out");
        }
    }
}

void UninstallSandboxAccounts(const std::filesystem::path& directory, const std::wstring& owner_sid) {
    QuiesceSandboxAccounts(directory, owner_sid);
    for (const auto& sid : OwnedSandboxAccountSids(directory, owner_sid)) {
        RemoveSandboxFirewall(sid);
        RemoveSandboxWfp(sid);
    }
    RestoreSandboxWfpAccess(owner_sid, directory);
    DeleteSandboxAccounts(directory, owner_sid);
}
}  // namespace mycli::sandbox
