#include "elevation.hpp"

#include <windows.h>
#include <shellapi.h>

#include <filesystem>
#include <stdexcept>
#include <vector>

#include "process.hpp"
#include "win32.hpp"

namespace mycli::sandbox {

int RunElevatedMaintenance(
    ElevatedMaintenance action,
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid) {
    std::vector<wchar_t> executable(32768);
    const DWORD chars = GetModuleFileNameW(
        nullptr, executable.data(), static_cast<DWORD>(executable.size()));
    if (chars == 0 || chars >= executable.size()) {
        throw Win32Error("GetModuleFileNameW");
    }

    SHELLEXECUTEINFOW launch{};
    launch.cbSize = sizeof(launch);
    launch.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    launch.lpVerb = L"runas";
    launch.lpFile = executable.data();
    const std::wstring verb = action == ElevatedMaintenance::kSetup ? L"--setup-for-user"
        : action == ElevatedMaintenance::kQuiesce ? L"--quiesce-for-user" : L"--uninstall-for-user";
    const std::wstring parameters =
        verb + L" " + QuoteWindowsArgument(state_directory.wstring()) +
        L" " + QuoteWindowsArgument(owner_sid);
    launch.lpParameters = parameters.c_str();
    launch.nShow = SW_HIDE;
    if (ShellExecuteExW(&launch) == FALSE) {
        const DWORD error = GetLastError();
        if (error == ERROR_CANCELLED) {
            throw ElevationCanceled{};
        }
        SetLastError(error);
        throw Win32Error("ShellExecuteExW(runas)");
    }
    const UniqueHandle process{launch.hProcess};
    if (WaitForSingleObject(process.get(), INFINITE) != WAIT_OBJECT_0) {
        throw Win32Error("WaitForSingleObject(elevated setup)");
    }
    DWORD exit_code = 0;
    if (GetExitCodeProcess(process.get(), &exit_code) == FALSE) {
        throw Win32Error("GetExitCodeProcess(elevated setup)");
    }
    return static_cast<int>(exit_code);
}

int RunElevatedSetup(const std::filesystem::path& directory, const std::wstring& owner_sid) {
    return RunElevatedMaintenance(ElevatedMaintenance::kSetup, directory, owner_sid);
}

}  // namespace mycli::sandbox
