#include <algorithm>
#include <exception>
#include <filesystem>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "acl.hpp"
#include "audit.hpp"
#include "state.hpp"
#include "maintenance.hpp"
#include "path-guard.hpp"
#include "protocol.hpp"
#include "sandbox.hpp"
#include "firewall.hpp"
#include "elevation.hpp"
#include "identity.hpp"
#include "token.hpp"
#include "wfp.hpp"
#include "win32.hpp"
#include "psec.hpp"
#include "psec-policy.hpp"
#include "psec-request-paths.hpp"
#include "psec-state.hpp"

namespace {

// Temporary phase profiling for local latency work; enabled with
// MYCLI_SANDBOX_PROFILE=1 and silent otherwise.
class PhaseTimer {
public:
    PhaseTimer(const char* label) : label_(label) {
        if (!Enabled()) return;
        LARGE_INTEGER counter{};
        QueryPerformanceCounter(&counter);
        start_ = counter.QuadPart;
    }
    ~PhaseTimer() {
        if (!Enabled()) return;
        LARGE_INTEGER counter{};
        LARGE_INTEGER frequency{};
        QueryPerformanceCounter(&counter);
        QueryPerformanceFrequency(&frequency);
        const double ms = static_cast<double>(counter.QuadPart - start_) * 1000.0 / static_cast<double>(frequency.QuadPart);
        std::cerr << "[profile] " << label_ << ": " << static_cast<int>(ms) << " ms\n";
    }

private:
    static bool Enabled() {
        return GetEnvironmentVariableW(L"MYCLI_SANDBOX_PROFILE", nullptr, 0) > 0;
    }
    const char* label_;
    long long start_ = 0;
};

constexpr wchar_t kHelperName[] = L"mycli-windows-sandbox";
using mycli::sandbox::SandboxIdentityKind;

using mycli::sandbox::SetupStateLock;

bool LegacyProvisioningPresent() {
    const auto directory = mycli::sandbox::SandboxStateDirectory();
    if (mycli::sandbox::SandboxAccountsExist(mycli::sandbox::CurrentUserSidString())) return true;
    for (const auto* name : {L"offline.credential", L"online.credential", L"proxy.credential",
            L"firewall.v1", L"proxy-access.v1.json", L"proxy-access.v1.tmp"}) {
        if (std::filesystem::exists(directory / name)) return true;
    }
    return false;
}

bool UsePsec() {
    if (std::filesystem::exists(mycli::sandbox::SandboxStateDirectory() / L"psec.v1")) return true;
    return !LegacyProvisioningPresent() && mycli::sandbox::PsecAvailable();
}

std::filesystem::path CurrentExecutablePath() {
    std::vector<wchar_t> path(32768);
    const DWORD chars = GetModuleFileNameW(
        nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (chars == 0 || chars >= path.size()) {
        throw std::runtime_error("failed to resolve Windows sandbox helper path");
    }
    return std::filesystem::path{std::wstring{path.data(), chars}};
}

bool SetupComplete() {
    const auto state_directory = mycli::sandbox::SandboxStateDirectory();
    const auto owner_sid = mycli::sandbox::CurrentUserSidString();
    try {
        if (UsePsec()) return mycli::sandbox::PsecSetupPresent();
        if (!mycli::sandbox::SandboxIdentityCredentialsExist(state_directory, SandboxIdentityKind::kOffline) ||
            !mycli::sandbox::SandboxIdentityCredentialsExist(state_directory, SandboxIdentityKind::kOnline) ||
            !mycli::sandbox::SandboxIdentityCredentialsExist(state_directory, SandboxIdentityKind::kProxy)) return false;
        const auto identity = mycli::sandbox::LoadSandboxIdentity(
            state_directory, owner_sid, SandboxIdentityKind::kOffline);
        const auto online = mycli::sandbox::LoadSandboxIdentity(
            state_directory, owner_sid, SandboxIdentityKind::kOnline);
        const auto proxy = mycli::sandbox::LoadSandboxIdentity(
            state_directory, owner_sid, SandboxIdentityKind::kProxy);
        if (EqualSid(identity.sid.get(), online.sid.get()) != 0 ||
            EqualSid(identity.sid.get(), proxy.sid.get()) != 0 ||
            EqualSid(online.sid.get(), proxy.sid.get()) != 0) return false;
        const auto capability = mycli::sandbox::DeriveCapabilitySid(state_directory, L"read-only");
        for (const auto token : {identity.token.get(), online.token.get(), proxy.token.get()}) {
            const auto restricted = mycli::sandbox::CreateRestrictedPrimaryTokenFrom(
                token, {capability.get()});
            if (IsTokenRestricted(restricted.get()) == 0) return false;
        }
        return mycli::sandbox::OfflineFirewallSetupReady(
            identity.sid_string, state_directory) &&
            mycli::sandbox::ProxyWfpReady(proxy.sid_string, owner_sid);
    } catch (const std::exception&) {
        return false;
    }
}

void SetupForUser(
    const std::filesystem::path& state_directory,
    const std::wstring& owner_sid) {
    mycli::sandbox::SetupSandboxIdentity(state_directory, owner_sid, SandboxIdentityKind::kOffline);
    mycli::sandbox::SetupSandboxIdentity(state_directory, owner_sid, SandboxIdentityKind::kOnline);
    mycli::sandbox::SetupSandboxIdentity(state_directory, owner_sid, SandboxIdentityKind::kProxy);
    const auto identity = mycli::sandbox::LoadSandboxIdentity(
        state_directory, owner_sid, SandboxIdentityKind::kOffline);
    mycli::sandbox::SetupOfflineFirewall(identity.sid_string, state_directory);
    const auto proxy = mycli::sandbox::LoadSandboxIdentity(
        state_directory, owner_sid, SandboxIdentityKind::kProxy);
    mycli::sandbox::SetupProxyWfp(proxy.sid_string, owner_sid, state_directory);
}

void EnsureSetupComplete() {
    const auto owner_sid = mycli::sandbox::CurrentUserSidString();
    const SetupStateLock setup_lock{owner_sid};
    static_cast<void>(setup_lock);
    if (SetupComplete()) {
        if (UsePsec() && !mycli::sandbox::PsecAvailable()) {
            throw std::runtime_error("psec_enforcement_unavailable");
        }
        return;
    }
    if (UsePsec()) {
        mycli::sandbox::SetupPsec();
        return;
    }

    const int exit_code = mycli::sandbox::RunElevatedSetup(
        mycli::sandbox::SandboxStateDirectory(),
        owner_sid);
    if (exit_code != 0) {
        throw std::runtime_error("Windows sandbox setup failed");
    }
    if (!SetupComplete()) {
        throw std::runtime_error(
            "Windows sandbox setup exited before setup completed");
    }
}

void ResetSetupState() {
    const auto owner_sid = mycli::sandbox::CurrentUserSidString();
    const SetupStateLock setup_lock{owner_sid};
    static_cast<void>(setup_lock);
    const auto state_directory = mycli::sandbox::SandboxStateDirectory();
    if (std::filesystem::exists(state_directory)) {
        mycli::sandbox::AclJournal journal{state_directory};
        journal.Cleanup();
    }
    mycli::sandbox::ResetSandboxIdentityCredentials(state_directory);
    mycli::sandbox::ResetOfflineFirewallState(state_directory);
    mycli::sandbox::ResetPsec();
}

void MaintainSandbox(bool uninstall) {
    using namespace mycli::sandbox;
    const auto owner_sid = CurrentUserSidString();
    const auto directory = SandboxStateDirectory();
    const SetupStateLock lock{owner_sid};
    std::unique_ptr<AclJournal> journal;
    if (std::filesystem::exists(directory)) {
        journal = std::make_unique<AclJournal>(directory);
        journal->StopHelpers();
    }
    if (UsePsec() && !LegacyProvisioningPresent()) {
        if (journal) journal->Cleanup();
        ResetPsec();
        journal.reset();
        if (uninstall) {
            if (std::filesystem::exists(directory)) {
                const PathGuard guard{directory};
                for (const auto* name : {L"acl-state.v1.json", L"acl-state.v1.tmp"}) {
                    std::filesystem::remove(directory / name);
                }
            }
        } else {
            SetupPsec();
        }
        return;
    }
    if (RunElevatedMaintenance(ElevatedMaintenance::kQuiesce, directory, owner_sid) != 0) {
        throw std::runtime_error("could not stop sandbox accounts for maintenance");
    }
    if (journal) journal->Cleanup();
    if (uninstall) {
        if (RunElevatedMaintenance(ElevatedMaintenance::kUninstall, directory, owner_sid) != 0) {
            throw std::runtime_error("sandbox uninstall did not complete; accounts remain disabled");
        }
        ResetSandboxIdentityCredentials(directory);
        ResetOfflineFirewallState(directory);
        ResetPsec();
        journal.reset();
        if (std::filesystem::exists(directory)) {
            const PathGuard guard{directory};
            for (const auto* name : {L"acl-state.v1.json", L"acl-state.v1.tmp", L"proxy-access.v1.json", L"proxy-access.v1.tmp"}) {
                std::filesystem::remove(directory / name);
            }
        }
        if (SandboxAccountsExist(owner_sid)) throw std::runtime_error("sandbox accounts remain after uninstall");
    } else {
        journal.reset();
        if (RunElevatedSetup(directory, owner_sid) != 0 || !SetupComplete()) {
            throw std::runtime_error("sandbox repair did not pass readiness verification");
        }
    }
}

bool ManagedStatePresent() {
    const auto directory = mycli::sandbox::SandboxStateDirectory();
    if (mycli::sandbox::SandboxAccountsExist(mycli::sandbox::CurrentUserSidString())) return true;
    for (const auto* name : {L"offline.credential", L"online.credential", L"proxy.credential",
            L"firewall.v1", L"acl-state.v1.json", L"acl-state.v1.tmp", L"proxy-access.v1.json", L"proxy-access.v1.tmp", L"psec.v1"}) {
        if (std::filesystem::exists(directory / name)) return true;
    }
    return false;
}

int Run(int argc, wchar_t* argv[]) {
    if (argc == 2 && std::wstring_view{argv[1]} == L"--check-host") {
        if (UsePsec()) {
            const bool available = mycli::sandbox::PsecAvailable();
            std::cout << "{\"backend\":\"psec\",\"status\":\"" << (available ? "no_known_blocker" : "blocked")
                      << "\",\"code\":\"" << (available ? "psec_available" : "psec_enforcement_unavailable")
                      << "\",\"scope\":\"environment_creation_and_process_attribute\"}\n";
            return available ? 0 : 1;
        }
        const auto audit = mycli::sandbox::InspectHostPublicWritePaths(std::filesystem::current_path(), {});
        const bool complete = audit.status == mycli::sandbox::PublicWriteAuditStatus::kComplete;
        const bool partial = audit.truncated || audit.uninspectable != 0;
        std::cout << "{\"status\":\"" << (!complete ? "blocked" : partial ? "partial" : "no_known_blocker")
                  << "\",\"code\":\"" << (complete && partial ? "host_audit_incomplete"
                      : mycli::sandbox::PublicWriteAuditCode(audit.status))
                  << "\",\"scope\":\"bounded_public_paths\",\"paths_checked\":" << audit.inspected
                  << ",\"paths_uninspectable\":" << audit.uninspectable
                  << ",\"scan_truncated\":" << (audit.truncated ? "true" : "false") << "}\n";
        return complete && !partial ? 0 : 1;
    }
    if (argc == 2 && std::wstring_view{argv[1]} == L"--handshake") {
        const bool psec = UsePsec();
        const bool setup_complete = SetupComplete();
        const bool sandbox_ready = setup_complete && (!psec || mycli::sandbox::PsecAvailable());
        std::wcout << L"{\"name\":\"" << kHelperName
                   << L"\",\"protocol_version\":"
                   << mycli::sandbox::kProtocolVersion
                   << L",\"backend\":\"" << (psec ? L"psec" : L"restricted_token") << L"\""
                   << L",\"setup_complete\":"
                   << (setup_complete ? L"true" : L"false")
                   << L",\"sandbox_ready\":"
                   << (sandbox_ready ? L"true" : L"false")
                   << L",\"managed_state_present\":"
                   << (ManagedStatePresent() ? L"true" : L"false")
                   << L"}\n";
        return 0;
    }
    if (argc == 2 && std::wstring_view{argv[1]} == L"--setup") {
        if (UsePsec()) {
            EnsureSetupComplete();
            return 0;
        }
        SetupForUser(
            mycli::sandbox::SandboxStateDirectory(),
            mycli::sandbox::CurrentUserSidString());
        std::wcout << L"Windows sandbox setup completed\n";
        return 0;
    }
    if (argc == 4 && std::wstring_view{argv[1]} == L"--setup-for-user") {
        SetupForUser(std::filesystem::path{argv[2]}, argv[3]);
        std::wcout << L"Windows sandbox setup completed\n";
        return 0;
    }
    if (argc == 4 && std::wstring_view{argv[1]} == L"--quiesce-for-user") {
        mycli::sandbox::QuiesceSandboxAccounts(std::filesystem::path{argv[2]}, argv[3]);
        return 0;
    }
    if (argc == 4 && std::wstring_view{argv[1]} == L"--uninstall-for-user") {
        mycli::sandbox::UninstallSandboxAccounts(std::filesystem::path{argv[2]}, argv[3]);
        return 0;
    }
    if (argc == 2 && (std::wstring_view{argv[1]} == L"--repair" || std::wstring_view{argv[1]} == L"--uninstall")) {
        MaintainSandbox(std::wstring_view{argv[1]} == L"--uninstall");
        return 0;
    }
    if (argc == 2 && std::wstring_view{argv[1]} == L"--ensure-setup") {
        EnsureSetupComplete();
        return 0;
    }
    if (argc == 2 && std::wstring_view{argv[1]} == L"--reset") {
        ResetSetupState();
        std::wcout << L"Windows sandbox setup state reset\n";
        return 0;
    }
    if ((argc == 4 && std::wstring_view{argv[1]} == L"--run-prepared-json") ||
        (argc == 3 && std::wstring_view{argv[1]} == L"--run-prepared-env")) {
        const bool carrier = argc == 3;
        if (mycli::sandbox::CurrentUserSidString() != argv[carrier ? 2 : 3]) {
            throw std::runtime_error("sandbox runner identity mismatch");
        }
        const auto request = mycli::sandbox::ParseAndValidateRequest(carrier ? mycli::sandbox::ReadRequestEnvironment() : argv[2]);
        mycli::sandbox::ClearRequestEnvironment();
        if (request.has_psec_options || request.mode == mycli::sandbox::SandboxMode::kFullAccess) {
            throw std::runtime_error("sandbox_policy_requires_psec");
        }
        return static_cast<int>(mycli::sandbox::RunPreparedSandboxRequest(request));
    }
    if ((argc == 3 && std::wstring_view{argv[1]} == L"--request-json") ||
        (argc == 2 && std::wstring_view{argv[1]} == L"--request-env")) {
        const bool carrier = argc == 2;
        auto request = mycli::sandbox::ParseAndValidateRequest(carrier ? mycli::sandbox::ReadRequestEnvironment() : argv[2]);
        const bool psec = UsePsec();
        if (!psec && (request.has_psec_options || request.mode == mycli::sandbox::SandboxMode::kFullAccess)) {
            throw std::runtime_error("sandbox_policy_requires_psec");
        }
        std::optional<mycli::sandbox::PsecRequestPaths> request_paths;
        {
            PhaseTimer validate_phase("validate+setup-check");
            if (psec) {
                auto validation = request;
                const mycli::sandbox::PsecRequestPaths validation_paths{validation};
                static_cast<void>(mycli::sandbox::ResolvePsecPolicy(validation));
            }
            EnsureSetupComplete();
        }
        const auto state_directory = mycli::sandbox::SandboxStateDirectory();
        const auto owner_sid = mycli::sandbox::CurrentUserSidString();
        if (psec) {
            mycli::sandbox::ClearRequestEnvironment();
            mycli::sandbox::PsecPolicy policy;
            {
                PhaseTimer journal_phase("journal-begin");
                const SetupStateLock preparation_lock{owner_sid};
                if (!mycli::sandbox::PsecSetupPresent()) throw std::runtime_error("psec_setup_changed");
                mycli::sandbox::AclJournal journal{state_directory};
                // Recover abandoned placeholders before pinning paths that may
                // name them. Active workloads retain their shared journal state.
                if (!journal.HasActiveHelpers()) journal.Cleanup();
                request_paths.emplace(request);
                std::vector<std::wstring> scope{L"psec"};
                for (const auto& root : request.workspace_roots) scope.push_back(L"read:" + root);
                for (const auto& root : request.writable_roots) scope.push_back(L"write:" + root);
                for (const auto& root : request.readable_roots) scope.push_back(L"read:" + root);
                for (const auto& root : request.readonly_roots) scope.push_back(L"readonly:" + root);
                for (const auto& root : request.denied_read_roots) scope.push_back(L"deny:" + root);
                if (request.filesystem == mycli::sandbox::FilesystemPolicy::kUnrestricted) scope.push_back(L"full");
                // PSEC policies are kernel-enforced per command and never edit host
                // ACLs, so divergent concurrent policies are admitted (Codex parity).
                journal.Begin(request.denied_read_roots, scope, mycli::sandbox::PolicyCoordination::kShared);
                try {
                    PhaseTimer policy_phase("build-policy");
                    policy = mycli::sandbox::PreparePsecPolicy(request);
                } catch (...) { request_paths.reset(); journal.End(); throw; }
            }
            const auto finish = [&]() {
                request_paths.reset();
                const SetupStateLock cleanup_lock{owner_sid};
                mycli::sandbox::AclJournal journal{state_directory};
                journal.End();
            };
            DWORD code;
            try {
                PhaseTimer run_phase("run-process");
                code = mycli::sandbox::RunPsecRequest(request, policy);
            } catch (...) { finish(); throw; }
            PhaseTimer finish_phase("journal-finish");
            finish();
            return static_cast<int>(code);
        }
        const auto kind = request.network_proxy_port != 0 ? SandboxIdentityKind::kProxy
            : request.network == mycli::sandbox::NetworkPolicy::kEnabled
                ? SandboxIdentityKind::kOnline : SandboxIdentityKind::kOffline;
        const auto identity = mycli::sandbox::LoadSandboxIdentity(
            state_directory, owner_sid, kind);
        const auto helper = CurrentExecutablePath();
        {
            // ACL updates are read/merge/write operations. Serialize preparation
            // across this owner's concurrent Shells without serializing execution.
            const SetupStateLock preparation_lock{owner_sid};
            static_cast<void>(preparation_lock);
            mycli::sandbox::AclJournal journal{state_directory};
            journal.Begin(request.denied_read_roots);
            mycli::sandbox::PrepareSandboxRequest(request, identity.sid.get());
            mycli::sandbox::GrantReadableRoot(helper.parent_path(), identity.sid.get());
        }
        return static_cast<int>(mycli::sandbox::RunAsSandboxIdentity(
            state_directory,
            owner_sid,
            kind,
            carrier ? std::vector<std::wstring>{helper.wstring(), L"--run-prepared-env", identity.sid_string}
                : std::vector<std::wstring>{helper.wstring(), L"--run-prepared-json", argv[2], identity.sid_string},
            std::filesystem::path{request.cwd}, request.network_proxy_port));
    }
    throw std::runtime_error(
        "expected --check-host, --handshake, --setup, --setup-for-user, --ensure-setup, "
        "--reset, --repair, --uninstall, or --request-json <json>");
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
    try {
        return std::clamp(Run(argc, argv), 0, 255);
    } catch (const mycli::sandbox::ElevationCanceled&) {
        return mycli::sandbox::kElevationCanceledExitCode;
    } catch (const std::exception& error) {
        std::cerr << "mycli Windows sandbox error: " << error.what() << '\n';
    }
    return 1;
}
