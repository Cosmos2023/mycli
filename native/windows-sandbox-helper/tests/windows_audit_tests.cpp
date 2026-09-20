#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include "acl.hpp"
#include "audit.hpp"
#include "state.hpp"

namespace {
using namespace mycli::sandbox;

class Fixture {
  public:
    Fixture() : path{std::filesystem::temp_directory_path() /
        (L"mycli-audit-tests-" + std::to_wstring(GetCurrentProcessId()))} {
        if (!std::filesystem::create_directory(path)) throw std::runtime_error("fixture already exists");
    }
    ~Fixture() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
    const std::filesystem::path path;
};

std::wstring Dacl(const std::filesystem::path& path) {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const DWORD status = GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, nullptr, &descriptor);
    if (status != ERROR_SUCCESS) throw std::runtime_error("read fixture security failed");
    LPWSTR raw = nullptr;
    const BOOL converted = ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor,
        SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &raw, nullptr);
    LocalFree(descriptor);
    if (!converted) throw std::runtime_error("serialize fixture security failed");
    const std::wstring text{raw};
    LocalFree(raw);
    return text;
}

void SetNullDacl(const std::filesystem::path& path) {
    const DWORD status = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, nullptr, nullptr);
    if (status != ERROR_SUCCESS) throw std::runtime_error("set fixture null DACL failed");
}

void Require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

void ExpectBlocked(const PublicWriteAudit& audit, const std::vector<LocalSid>& capabilities,
    const std::string& expected) {
    try {
        ApplyPublicWriteAudit(audit, capabilities);
    } catch (const std::runtime_error& error) {
        Require(error.what() == expected, "unexpected audit rejection");
        return;
    }
    throw std::runtime_error("blocked audit changed permissions");
}

void RunTests() {
    const Fixture fixture;
    const auto writable = fixture.path / L"public";
    const auto null_path = fixture.path / L"null";
    const auto journal_path = fixture.path / L"journal";
    for (const auto& path : {writable, null_path, journal_path}) std::filesystem::create_directory(path);
    const auto world = SidFromString(L"S-1-1-0");
    GrantWritableRoot(writable, world.get());
    SetNullDacl(null_path);
    const auto before = Dacl(writable);
    const auto null_before = Dacl(null_path);
    std::vector<LocalSid> capabilities;
    capabilities.push_back(DeriveCapabilitySid(fixture.path, L"audit-test"));

    const auto blocked = InspectPublicWritePaths({writable, null_path}, {});
    Require(blocked.status == PublicWriteAuditStatus::kNullDacl, "null DACL was not detected");
    Require(blocked.targets.size() == 1 && blocked.inspected == 2, "scan did not inspect both paths");
    ExpectBlocked(blocked, capabilities, "host_null_dacl");
    Require(Dacl(writable) == before && Dacl(null_path) == null_before,
        "preflight failure changed a fixture DACL");

    const auto allowed = InspectPublicWritePaths({null_path}, {null_path.wstring()});
    Require(allowed.status == PublicWriteAuditStatus::kComplete && allowed.targets.empty(),
        "an allowed write root was treated as an outside write grant");

    const auto complete = InspectPublicWritePaths({writable}, {});
    Require(complete.status == PublicWriteAuditStatus::kComplete && complete.targets.size() == 1,
        "writable path was not planned");
    Require(Dacl(writable) == before, "inspection was not read-only");
    {
        AclJournal journal{journal_path};
        ApplyPublicWriteAudit(complete, capabilities);
        Require(Dacl(writable) != before, "complete plan did not apply a deny");
        journal.Cleanup();
        Require(Dacl(writable) == before, "applied audit did not restore unrelated permissions");
    }

    SetNullDacl(writable);
    ExpectBlocked(complete, capabilities, "sandbox cannot safely modify a null DACL");
    Require(InspectPublicWritePaths({writable}, {}).status == PublicWriteAuditStatus::kNullDacl,
        "a DACL changed after inspection was overwritten");

    const auto large = fixture.path / L"large";
    std::filesystem::create_directory(large);
    for (int index = 0; index < 1001; ++index) {
        std::ofstream file{large / (std::to_wstring(index) + L".txt")};
        Require(static_cast<bool>(file), "create audit limit fixture failed");
    }
    const auto bounded = InspectPublicWritePaths({large}, {});
    Require(bounded.truncated, "truncated audit was not reported");
}
}

int main() {
    try {
        RunTests();
        std::cout << "host audit fixtures passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
