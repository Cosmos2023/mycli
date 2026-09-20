#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <winioctl.h>

#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

#include "psec.hpp"
#include "psec-policy.hpp"
#include "psec-request-paths.hpp"
#include "process.hpp"
#include "desktop.hpp"

namespace {
using namespace mycli::sandbox;

void Require(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}

class Fixture {
  public:
    Fixture() : root{std::filesystem::temp_directory_path() /
        (L"mycli-psec-tests-" + std::to_wstring(GetCurrentProcessId()))} {
        Require(std::filesystem::create_directory(root), "fixture already exists");
    }
    ~Fixture() {
        std::error_code ignored;
        std::filesystem::remove_all(root, ignored);
    }
    const std::filesystem::path root;
};

void NullDacl(const std::filesystem::path& path, bool low) {
    Require(SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS, "fixture NULL DACL");
    if (low) {
        PSECURITY_DESCRIPTOR descriptor = nullptr;
        Require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;OICI;NW;;;LW)",
            SDDL_REVISION_1, &descriptor, nullptr) != 0, "fixture integrity descriptor");
        BOOL present = FALSE;
        BOOL defaulted = FALSE;
        PACL label = nullptr;
        const BOOL found = GetSecurityDescriptorSacl(descriptor, &present, &label, &defaulted);
        const DWORD result = found && present ? SetNamedSecurityInfoW(
            const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION,
            nullptr, nullptr, nullptr, label) : ERROR_INVALID_DATA;
        LocalFree(descriptor);
        Require(result == ERROR_SUCCESS, "fixture low integrity");
    }
}

void Junction(const std::filesystem::path& link, const std::filesystem::path& target) {
    Require(std::filesystem::create_directory(link), "fixture junction directory");
    const auto substitute = L"\\??\\" + target.wstring();
    struct MountPoint {
        DWORD tag = IO_REPARSE_TAG_MOUNT_POINT;
        WORD data_length = 0, reserved = 0;
        WORD substitute_offset = 0, substitute_length = 0, print_offset = 0, print_length = 0;
        wchar_t names[4096]{};
    };
    static_assert(offsetof(MountPoint, names) == 16);
    auto data = std::make_unique<MountPoint>();
    Require(substitute.size() + 2 < 4096, "fixture junction path length");
    data->substitute_length = static_cast<WORD>(substitute.size() * sizeof(wchar_t));
    data->print_offset = data->substitute_length + sizeof(wchar_t);
    data->data_length = 8 + data->print_offset + sizeof(wchar_t);
    std::copy(substitute.begin(), substitute.end(), data->names);
    const UniqueHandle handle{CreateFileW(link.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr)};
    DWORD returned = 0;
    Require(handle && DeviceIoControl(handle.get(), FSCTL_SET_REPARSE_POINT, data.get(),
        8 + data->data_length, nullptr, 0, &returned, nullptr), "fixture junction creation");
}

void Tests() {
    Require(PsecAvailable(), "PSEC environment or startup attribute unavailable");
    const Fixture fixture;
    const auto workspace = fixture.root / "workspace";
    const auto outside = fixture.root / "outside";
    const auto medium_null = fixture.root / "medium-null";
    const auto low_null = fixture.root / "low-null";
    const auto metadata = workspace / ".git";
    for (const auto& path : {workspace, outside, medium_null, low_null, metadata}) {
        std::filesystem::create_directories(path);
    }
    NullDacl(medium_null, false);
    NullDacl(low_null, true);
    const auto secret = workspace / "secret";
    { std::ofstream file{secret}; file << "sentinel"; }
    const auto private_file = outside / "private-file";
    { std::ofstream file{private_file}; file << "fixture"; }
    wchar_t executable[32768]{};
    wchar_t windows[32768]{};
    Require(GetModuleFileNameW(nullptr, executable, 32768) != 0, "test executable");
    Require(GetWindowsDirectoryW(windows, 32768) != 0, "Windows directory");
    PsecPolicy policy;
    policy.read_roots = {fixture.root.wstring(),
        std::filesystem::path{executable}.parent_path().wstring(), windows, metadata.wstring()};
    policy.write_roots = {workspace.wstring()};
    policy.denied_roots = {secret.wstring()};
    const auto run = [&](const PsecPolicy& current, const wchar_t* operation,
        const std::filesystem::path& target, DWORD expected, const char* label) {
        const PsecEnvironment environment{BuildPsecSpecification(current)};
        const auto code = RunPsecProcessInJob(environment.get(),
            {executable, operation, target.wstring()}, workspace);
        std::cout << label << ": " << code << '\n';
        Require(code == expected, label);
    };
    run(policy, L"--write", workspace / "allowed", 0, "workspace write");
    run(policy, L"--write", outside / "denied", 5, "outside write");
    run(policy, L"--write", medium_null / "denied", 5, "medium NULL DACL write");
    run(policy, L"--write", low_null / "denied", 5, "low NULL DACL write");
    run(policy, L"--write", metadata / "denied", 5, "readonly metadata write");
    run(policy, L"--read", secret, 5, "denied content read");
    run(policy, L"--write", secret, 5, "denied content write");
    run(policy, L"--remove", secret, 5, "denied content remove");
    {
        const auto volume = fixture.root / "snapshot-volume";
        const auto alias_target = fixture.root / "snapshot-target";
        const auto readonly_target = alias_target / "readonly";
        std::filesystem::create_directory(volume);
        std::filesystem::create_directories(readonly_target);
        Junction(volume / "alias", alias_target);
        const auto snapshot_secret = alias_target / "secret";
        { std::ofstream file{snapshot_secret}; file << "snapshot-secret"; }
        auto snapshot = policy;
        snapshot.write_roots = SnapshotPsecVolumeRoots({volume.wstring()});
        Require(std::any_of(snapshot.write_roots.begin(), snapshot.write_roots.end(), [&](const auto& path) {
            return std::filesystem::equivalent(path, alias_target);
        }), "snapshot must include local junction target");
        snapshot.read_roots.push_back(readonly_target.wstring());
        snapshot.denied_roots.push_back(snapshot_secret.wstring());
        run(snapshot, L"--write", volume / "alias" / "allowed", 0, "snapshot junction write");
        run(snapshot, L"--write", volume / "alias" / "readonly" / "blocked", 5, "snapshot readonly alias");
        run(snapshot, L"--read", volume / "alias" / "secret", 5, "snapshot denied alias");
        run(snapshot, L"--write", snapshot_secret, 5, "snapshot denied target write");
    }
    const auto alias = workspace / "secret-alias";
    Require(CreateHardLinkW(alias.c_str(), secret.c_str(), nullptr) != 0, "fixture hardlink");
    run(policy, L"--link", secret, 5, "runtime denied hardlink creation");
    run(policy, L"--link", outside / "private-file", 5, "runtime outside hardlink creation");
    run(policy, L"--link-fresh", workspace, 5, "runtime denied self-created hardlink");
    Require(!std::filesystem::exists(workspace / L"fresh-link"), "self-created hardlink escaped PSEC");
    run(policy, L"--desktop", workspace, 0, "private desktop");
    {
        WSADATA data{};
        Require(WSAStartup(MAKEWORD(2, 2), &data) == 0, "egress fixture winsock startup");
        const SOCKET listener{::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)};
        Require(listener != INVALID_SOCKET, "egress fixture listener socket");
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_port = 0;
        InetPtonW(AF_INET, L"127.0.0.1", &address.sin_addr);
        Require(bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0,
            "egress fixture bind");
        Require(listen(listener, 1) == 0, "egress fixture listen");
        int length = sizeof(address);
        Require(getsockname(listener, reinterpret_cast<sockaddr*>(&address), &length) == 0,
            "egress fixture port");
        const auto port = static_cast<unsigned short>(ntohs(address.sin_port));
        const auto port_text = std::to_wstring(port);

        auto allowed = policy;
        allowed.network_enabled = true;
        NetworkEgressPolicy rules;
        NetworkEgressRule rule;
        rule.destinations.push_back(NetworkDestination{L"127.0.0.1/32", {}});
        rule.ports.push_back(NetworkPortRule{NetworkRuleProtocol::kTcp, port, 0});
        rules.allow.push_back(rule);
        allowed.network_egress = rules;
        run(allowed, L"--connect", std::filesystem::path{port_text}, 0, "allowed egress rule");

        auto unmatched = policy;
        unmatched.network_enabled = true;
        NetworkEgressPolicy other_port;
        other_port.allow.push_back(NetworkEgressRule{
            {NetworkDestination{L"127.0.0.1/32", {}}},
            {NetworkPortRule{NetworkRuleProtocol::kTcp,
                static_cast<unsigned short>(port == 65'535 ? 65'534 : port + 1), 0}},
        });
        unmatched.network_egress = other_port;
        run(unmatched, L"--connect", std::filesystem::path{port_text}, 2,
            "unmatched egress rule");

        auto denied = policy;
        denied.network_enabled = true;
        NetworkEgressPolicy closed;
        closed.allow_default = false;
        denied.network_egress = closed;
        run(denied, L"--connect", std::filesystem::path{port_text}, 2, "denied egress default");

        closesocket(listener);
        WSACleanup();
    }
    {
        const PsecEnvironment environment{BuildPsecSpecification(policy)};
        const auto cmd = (std::filesystem::path{windows} / "System32" / "cmd.exe").wstring();
        for (const auto& target : {workspace / "quoted & allowed", outside / "quoted & denied"}) {
            const auto command = L"\"" + std::wstring{executable} + L"\" --write \"" + target.wstring() + L"\"";
            const auto code = RunPsecProcessInJob(environment.get(),
                {cmd, L"/d", L"/s", L"/c", command}, workspace);
            const bool allowed = target.parent_path() == workspace;
            Require(code == (allowed ? 0u : 5u), "cmd quoted command exit");
            Require(std::filesystem::exists(target) == allowed, "cmd quoted command boundary");
        }
    }
    policy.write_roots.clear();
    run(policy, L"--write", workspace / "readonly", 5, "readonly workspace write");
    for (const auto& path : {outside, medium_null, low_null, metadata}) {
        Require(!std::filesystem::exists(path / "denied"), "outside mutation escaped PSEC");
    }
    std::ifstream content{secret};
    std::string value;
    content >> value;
    Require(value == "sentinel", "secret changed");

    const auto metadata_child = metadata / "child";
    std::filesystem::create_directory(metadata_child);
    SandboxRequest request{};
    request.cwd = workspace.wstring();
    request.workspace_roots = {workspace.wstring()};
    request.writable_roots = {workspace.wstring(), metadata.wstring(), metadata_child.wstring()};
    request.mode = SandboxMode::kWorkspaceWrite;
    request.filesystem = FilesystemPolicy::kWorkspaceWrite;
    request.command_argv = {executable, L"--write", (metadata_child / "blocked").wstring()};
    {
        auto canonical = request;
        const PsecRequestPaths canonical_paths{canonical};
        wchar_t short_path[32768]{};
        Require(GetShortPathNameW(workspace.c_str(), short_path, 32768) != 0, "fixture short path");
        auto short_request = request;
        short_request.cwd = (std::filesystem::path{short_path} / L".").wstring();
        short_request.workspace_roots = {short_path};
        short_request.writable_roots = {short_path};
        const PsecRequestPaths short_paths{short_request};
        Require(short_request.cwd == canonical.cwd && short_request.workspace_roots == canonical.workspace_roots &&
            short_request.writable_roots.front() == canonical.writable_roots.front(), "canonical PSEC lease identity");
    }
    Require(RunPsecRequest(request) == 5, "metadata explicit write override");
    request.command_argv = {executable, L"--write", (workspace / ".codex").wstring()};
    Require(RunPsecRequest(request) == 5, "absent metadata write");
    request.denied_read_roots = {metadata.wstring()};
    request.command_argv = {executable, L"--write", (metadata_child / "blocked").wstring()};
    Require(RunPsecRequest(request) == 5, "nested grant overrides deny");
    request.command_argv = {executable, L"--read", private_file.wstring()};
    Require(RunPsecRequest(request) == 5, "private sibling read");
    request.readable_roots = {outside.wstring()};
    request.explicit_read_roots = true;
    Require(RunPsecRequest(request) == 0, "explicit readable sibling");
    const auto readonly = workspace / "vendor";
    std::filesystem::create_directory(readonly);
    const auto readonly_file = readonly / "library";
    { std::ofstream file{readonly_file}; file << "library"; }
    request.readonly_roots = {readonly.wstring()};
    request.writable_roots.push_back(readonly.wstring());
    request.command_argv = {executable, L"--read", readonly_file.wstring()};
    Require(RunPsecRequest(request) == 0, "readonly carveout read");
    request.command_argv = {executable, L"--write", readonly_file.wstring()};
    Require(RunPsecRequest(request) == 5, "readonly carveout write");
    request.writable_roots.pop_back();
    request.mode = SandboxMode::kFullAccess;
    request.filesystem = FilesystemPolicy::kUnrestricted;
    request.command_argv = {executable, L"--write", outside.wstring() + L"\\full-access"};
    Require(RunPsecRequest(request) == 0, "full filesystem external write");
    request.command_argv = {executable, L"--write", readonly_file.wstring()};
    Require(RunPsecRequest(request) == 5, "full filesystem retains carveout");
    request.mode = SandboxMode::kWorkspaceWrite;
    request.filesystem = FilesystemPolicy::kWorkspaceWrite;
    request.denied_read_roots = {secret.wstring()};
    request.command_argv = {executable, L"--read", alias.wstring()};
    Require(RunPsecRequest(request) == 5, "denied hardlink read");
    request.command_argv = {executable, L"--write", alias.wstring()};
    Require(RunPsecRequest(request) == 5, "denied hardlink write");
    request.writable_roots.push_back(alias.wstring());
    Require(RunPsecRequest(request) == 5, "denied hardlink explicit write override");
    request.writable_roots.pop_back();
    const auto protected_file = metadata / "config";
    { std::ofstream file{protected_file}; file << "protected"; }
    const auto protected_alias = workspace / "config-alias";
    Require(CreateHardLinkW(protected_alias.c_str(), protected_file.c_str(), nullptr) != 0,
        "metadata hardlink fixture");
    request.writable_roots.push_back(protected_alias.wstring());
    request.command_argv = {executable, L"--write", protected_alias.wstring()};
    Require(RunPsecRequest(request) == 5, "metadata hardlink explicit write override");
    request.writable_roots.pop_back();
    const auto external_alias = workspace / "outside-link";
    Require(CreateHardLinkW(external_alias.c_str(), private_file.c_str(), nullptr) != 0, "outside hardlink fixture");
    // Accepted residual: a host-created hardlink alias inside a writable root is
    // not rejected before launch. PSEC denies every link creation inside the
    // sandbox, so only an actor outside the sandbox can introduce the alias, and
    // the shipped Codex Windows sandbox accepts the same case.
    bool accepted = true;
    try { static_cast<void>(PreparePsecPolicy(request)); }
    catch (const std::exception& error) {
        accepted = false;
        std::printf("  writable hardlink alias rejected: %s\n", error.what());
    }
    Require(accepted, "writable hardlink alias must not block launch preparation");
    for (const auto& path : {medium_null, low_null}) {
        PACL dacl = nullptr;
        PSECURITY_DESCRIPTOR descriptor = nullptr;
        const DWORD status = GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION, nullptr, nullptr, &dacl, nullptr, &descriptor);
        const bool unchanged = status == ERROR_SUCCESS && dacl == nullptr;
        if (descriptor) LocalFree(descriptor);
        Require(unchanged, "host NULL DACL changed");
    }
}
}  // namespace

int wmain(int argc, wchar_t* argv[]) {
    if (argc == 3) {
        const std::wstring_view operation{argv[1]};
        if (operation == L"--connect") {
            WSADATA data{};
            if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return 2;
            const SOCKET socket_handle{::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)};
            if (socket_handle == INVALID_SOCKET) {
                WSACleanup();
                return 2;
            }
            sockaddr_in address{};
            address.sin_family = AF_INET;
            address.sin_port = htons(static_cast<u_short>(std::stoul(argv[2])));
            InetPtonW(AF_INET, L"127.0.0.1", &address.sin_addr);
            int code = 0;
            u_long nonblocking = 1;
            ioctlsocket(socket_handle, FIONBIO, &nonblocking);
            if (::connect(socket_handle, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0
                && WSAGetLastError() != WSAEWOULDBLOCK) {
                code = 1;
            } else {
                fd_set writable;
                FD_ZERO(&writable);
                FD_SET(socket_handle, &writable);
                timeval timeout{2, 0};
                if (select(0, nullptr, &writable, nullptr, &timeout) <= 0) {
                    code = 2;
                } else {
                    int error = 0;
                    int length = sizeof(error);
                    if (getsockopt(socket_handle, SOL_SOCKET, SO_ERROR,
                            reinterpret_cast<char*>(&error), &length) != 0 || error != 0) code = 1;
                }
            }
            closesocket(socket_handle);
            WSACleanup();
            return code;
        }
        if (operation == L"--link") {
            return CreateHardLinkW((std::filesystem::current_path() / "new-link").c_str(), argv[2], nullptr)
                ? 0 : static_cast<int>(GetLastError());
        }
        if (operation == L"--link-fresh") {
            // The per-command concurrency model relies on PSEC denying alias creation
            // even for a file the sandboxed process created inside its own write root.
            const std::filesystem::path root{argv[2]};
            const auto source = root / L"fresh-source";
            const UniqueHandle file{CreateFileW(source.c_str(), GENERIC_WRITE, 0, nullptr,
                CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr)};
            if (!file) return static_cast<int>(GetLastError());
            const char payload[] = "fresh";
            DWORD written = 0;
            if (WriteFile(file.get(), payload, sizeof(payload) - 1, &written, nullptr) == 0 ||
                written != sizeof(payload) - 1) return static_cast<int>(GetLastError());
            return CreateHardLinkW((root / L"fresh-link").c_str(), source.c_str(), nullptr)
                ? 0 : static_cast<int>(GetLastError());
        }
        if (operation == L"--desktop") {
            if (CurrentDesktopName().find(L"\\MycliSandbox-") == std::wstring::npos) return 1;
            const auto desktop = OpenDesktopW(L"Default", 0, FALSE, DESKTOP_HOOKCONTROL | DESKTOP_SWITCHDESKTOP);
            if (desktop != nullptr) { CloseDesktop(desktop); return 2; }
            return 0;
        }
        if (operation == L"--remove") return DeleteFileW(argv[2]) ? 0 : static_cast<int>(GetLastError());
        const bool write = operation == L"--write";
        const HANDLE file = CreateFileW(argv[2], write ? GENERIC_WRITE : GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
            write ? CREATE_ALWAYS : OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file == INVALID_HANDLE_VALUE) return static_cast<int>(GetLastError());
        CloseHandle(file);
        return 0;
    }
    try { Tests(); return 0; }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
