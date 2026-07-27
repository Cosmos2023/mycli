#include "elevation.hpp"

#include <windows.h>
#include <shellapi.h>

#include <filesystem>
#include <stdexcept>
#include <vector>

#include "win32.hpp"

namespace mycli::sandbox {

int RunElevatedSetup() {
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
    launch.lpParameters = L"--setup";
    launch.nShow = SW_SHOWNORMAL;
    if (ShellExecuteExW(&launch) == FALSE) {
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

}  // namespace mycli::sandbox
