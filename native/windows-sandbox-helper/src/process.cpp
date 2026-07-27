#include "process.hpp"

#include <windows.h>

#include <cstddef>
#include <cwctype>
#include <stdexcept>
#include <utility>
#include <vector>

#include "win32.hpp"

namespace mycli::sandbox {
namespace {

class ThreadAttributeList {
  public:
    explicit ThreadAttributeList(DWORD attribute_count) {
        SIZE_T bytes = 0;
        InitializeProcThreadAttributeList(nullptr, attribute_count, 0, &bytes);
        storage_.resize(bytes);
        list_ = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(storage_.data());
        if (InitializeProcThreadAttributeList(list_, attribute_count, 0, &bytes) == 0) {
            throw Win32Error("InitializeProcThreadAttributeList");
        }
    }

    ~ThreadAttributeList() {
        if (list_ != nullptr) {
            DeleteProcThreadAttributeList(list_);
        }
    }

    ThreadAttributeList(const ThreadAttributeList&) = delete;
    ThreadAttributeList& operator=(const ThreadAttributeList&) = delete;

    [[nodiscard]] PPROC_THREAD_ATTRIBUTE_LIST get() noexcept {
        return list_;
    }

  private:
    std::vector<std::byte> storage_;
    PPROC_THREAD_ATTRIBUTE_LIST list_ = nullptr;
};

UniqueHandle OpenNullDevice(DWORD desired_access) {
    const HANDLE handle = CreateFileW(
        L"NUL",
        desired_access,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
        throw Win32Error("CreateFileW(NUL)");
    }
    return UniqueHandle{handle};
}

UniqueHandle DuplicateStandardHandle(DWORD standard_handle, DWORD null_access) {
    HANDLE source = GetStdHandle(standard_handle);
    UniqueHandle fallback;
    if (source == nullptr || source == INVALID_HANDLE_VALUE) {
        fallback = OpenNullDevice(null_access);
        source = fallback.get();
    }

    HANDLE duplicate = nullptr;
    if (DuplicateHandle(
            GetCurrentProcess(),
            source,
            GetCurrentProcess(),
            &duplicate,
            0,
            TRUE,
            DUPLICATE_SAME_ACCESS) == 0) {
        throw Win32Error("DuplicateHandle(stdio)");
    }
    return UniqueHandle{duplicate};
}

UniqueHandle CreateKillOnCloseJob() {
    const UniqueHandle job{CreateJobObjectW(nullptr, nullptr)};
    if (!job) {
        throw Win32Error("CreateJobObjectW");
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (SetInformationJobObject(
            job.get(),
            JobObjectExtendedLimitInformation,
            &limits,
            sizeof(limits)) == 0) {
        throw Win32Error("SetInformationJobObject");
    }
    return job;
}

}  // namespace

std::wstring QuoteWindowsArgument(const std::wstring& argument) {
    if (!argument.empty() &&
        argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
        return argument;
    }

    std::wstring quoted{L'\"'};
    std::size_t backslashes = 0;
    for (const wchar_t character : argument) {
        if (character == L'\\') {
            ++backslashes;
            continue;
        }
        if (character == L'\"') {
            quoted.append(backslashes * 2 + 1, L'\\');
            quoted.push_back(L'\"');
            backslashes = 0;
            continue;
        }
        quoted.append(backslashes, L'\\');
        backslashes = 0;
        quoted.push_back(character);
    }
    quoted.append(backslashes * 2, L'\\');
    quoted.push_back(L'\"');
    return quoted;
}

std::wstring BuildWindowsCommandLine(const std::vector<std::wstring>& argv) {
    if (argv.empty() || argv.front().empty()) {
        throw std::invalid_argument("command argv must contain an executable");
    }
    std::wstring command_line;
    for (const auto& argument : argv) {
        if (!command_line.empty()) {
            command_line.push_back(L' ');
        }
        command_line.append(QuoteWindowsArgument(argument));
    }
    return command_line;
}

DWORD RunProcessInJob(
    HANDLE primary_token,
    const std::vector<std::wstring>& argv,
    const std::filesystem::path& cwd) {
    if (primary_token == nullptr || primary_token == INVALID_HANDLE_VALUE) {
        throw std::invalid_argument("primary token handle is invalid");
    }
    auto command_line = BuildWindowsCommandLine(argv);
    std::vector<wchar_t> mutable_command_line(
        command_line.begin(), command_line.end());
    mutable_command_line.push_back(L'\0');

    const auto stdin_handle = DuplicateStandardHandle(STD_INPUT_HANDLE, GENERIC_READ);
    const auto stdout_handle = DuplicateStandardHandle(STD_OUTPUT_HANDLE, GENERIC_WRITE);
    const auto stderr_handle = DuplicateStandardHandle(STD_ERROR_HANDLE, GENERIC_WRITE);
    std::vector<HANDLE> inherited_handles{
        stdin_handle.get(), stdout_handle.get(), stderr_handle.get()};

    ThreadAttributeList attributes{1};
    if (UpdateProcThreadAttribute(
            attributes.get(),
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            inherited_handles.data(),
            inherited_handles.size() * sizeof(HANDLE),
            nullptr,
            nullptr) == 0) {
        throw Win32Error("UpdateProcThreadAttribute(handle list)");
    }

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin_handle.get();
    startup.StartupInfo.hStdOutput = stdout_handle.get();
    startup.StartupInfo.hStdError = stderr_handle.get();
    startup.lpAttributeList = attributes.get();

    PROCESS_INFORMATION process_info{};
    const auto job = CreateKillOnCloseJob();
    constexpr DWORD kCreationFlags =
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
    if (CreateProcessAsUserW(
            primary_token,
            nullptr,
            mutable_command_line.data(),
            nullptr,
            nullptr,
            TRUE,
            kCreationFlags,
            nullptr,
            cwd.c_str(),
            &startup.StartupInfo,
            &process_info) == 0) {
        throw Win32Error("CreateProcessAsUserW");
    }
    const UniqueHandle process{process_info.hProcess};
    const UniqueHandle thread{process_info.hThread};

    if (AssignProcessToJobObject(job.get(), process.get()) == 0) {
        TerminateProcess(process.get(), 1);
        throw Win32Error("AssignProcessToJobObject");
    }
    if (ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
        TerminateJobObject(job.get(), 1);
        throw Win32Error("ResumeThread");
    }
    if (WaitForSingleObject(process.get(), INFINITE) != WAIT_OBJECT_0) {
        TerminateJobObject(job.get(), 1);
        throw Win32Error("WaitForSingleObject");
    }

    DWORD exit_code = 0;
    if (GetExitCodeProcess(process.get(), &exit_code) == 0) {
        throw Win32Error("GetExitCodeProcess");
    }
    return exit_code;
}

}  // namespace mycli::sandbox
