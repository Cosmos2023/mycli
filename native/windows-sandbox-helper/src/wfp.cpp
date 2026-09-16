#include "wfp.hpp"

#include <windows.h>
#include <aclapi.h>
#include <fwpmu.h>
#include <rpc.h>

#include <array>
#include <cstring>
#include <stdexcept>
#include <string>

#include "sid.hpp"
#include "token.hpp"
#include "wfp-access.hpp"

namespace mycli::sandbox {
namespace {

constexpr GUID kProviderKey{
    0x9a91d8d2, 0x9d9b, 0x415b, {0xb3, 0x04, 0x29, 0x78, 0xd0, 0xe4, 0xd6, 0x0c}};
constexpr GUID kAleAuthConnectV4{
    0xc38d57d1, 0x05a7, 0x4c33, {0x90, 0x4f, 0x7f, 0xbc, 0xee, 0xe6, 0x0e, 0x82}};
constexpr GUID kAleAuthConnectV6{
    0x4a72393b, 0x319f, 0x44bc, {0x84, 0xc3, 0xba, 0x54, 0xdc, 0xb3, 0xb6, 0xb4}};
constexpr GUID kAleUserId{
    0xaf043a0a, 0xb34d, 0x4f86, {0x97, 0x9c, 0xc9, 0x03, 0x71, 0xaf, 0x6e, 0x66}};
constexpr UINT32 kPersistentFlag = 0x00000001;

struct FilterSpec {
    GUID key;
    const GUID* layer;
    const wchar_t* name;
};

GUID SublayerKey(const std::wstring& account_sid) {
    const auto digest = HashSandboxKey(L"mycli/windows/network/sublayer/" + account_sid);
    GUID key{};
    std::memcpy(&key, digest.data(), sizeof(key));
    return key;
}

// Stable keys include the account SID: provisioning another Windows user must
// never replace filters protecting an already-running sandbox.
std::array<FilterSpec, 4> FilterSpecs(const std::wstring& account_sid) {
    const auto make = [&](const GUID* layer, const wchar_t* scope) {
        const auto digest = HashSandboxKey(L"mycli/windows/network/" + account_sid + L"/" + scope);
        GUID key{};
        std::memcpy(&key, digest.data(), sizeof(key));
        return FilterSpec{key, layer, scope};
    };
    return {{
        make(&kAleAuthConnectV4, L"Block Connect IPv4"),
        make(&kAleAuthConnectV6, L"Block Connect IPv6"),
        make(&FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4, L"Block Accept IPv4"),
        make(&FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6, L"Block Accept IPv6"),
    }};
}

void RequireWfpSuccess(DWORD result, const char* operation) {
    if (result != ERROR_SUCCESS) {
        throw std::runtime_error(
            std::string{operation} + " failed with WFP error " + std::to_string(result));
    }
}

bool IsWfpResult(DWORD result, HRESULT expected) {
    return result == static_cast<DWORD>(expected);
}

class Engine {
  public:
    explicit Engine(bool dynamic = false) {
        std::wstring name = L"mycli Windows Sandbox WFP";
        FWPM_SESSION0 session{};
        session.displayData.name = name.data();
        session.flags = dynamic ? FWPM_SESSION_FLAG_DYNAMIC : 0;
        session.txnWaitTimeoutInMSec = INFINITE;
        RequireWfpSuccess(
            FwpmEngineOpen0(
                nullptr,
                RPC_C_AUTHN_DEFAULT,
                nullptr,
                &session,
                &handle_),
            "FwpmEngineOpen0");
    }

    ~Engine() {
        if (handle_ != nullptr) FwpmEngineClose0(handle_);
    }

    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    [[nodiscard]] HANDLE get() const noexcept {
        return handle_;
    }

    HANDLE release() noexcept {
        const auto handle = handle_;
        handle_ = nullptr;
        return handle;
    }

  private:
    HANDLE handle_ = nullptr;
};

class Transaction {
  public:
    explicit Transaction(HANDLE engine) : engine_{engine} {
        RequireWfpSuccess(FwpmTransactionBegin0(engine_, 0), "FwpmTransactionBegin0");
    }

    ~Transaction() {
        if (!committed_) FwpmTransactionAbort0(engine_);
    }

    Transaction(const Transaction&) = delete;
    Transaction& operator=(const Transaction&) = delete;

    void Commit() {
        RequireWfpSuccess(FwpmTransactionCommit0(engine_), "FwpmTransactionCommit0");
        committed_ = true;
    }

  private:
    HANDLE engine_;
    bool committed_ = false;
};

class UserCondition {
  public:
    explicit UserCondition(PSID sid) {
        EXPLICIT_ACCESSW access{};
        access.grfAccessPermissions = FWP_ACTRL_MATCH_FILTER;
        access.grfAccessMode = GRANT_ACCESS;
        access.grfInheritance = NO_INHERITANCE;
        access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        access.Trustee.TrusteeType = TRUSTEE_IS_USER;
        access.Trustee.ptstrName = static_cast<LPWSTR>(sid);
        ULONG bytes = 0;
        const DWORD result = BuildSecurityDescriptorW(
            nullptr,
            nullptr,
            1,
            &access,
            0,
            nullptr,
            nullptr,
            &bytes,
            &descriptor_);
        RequireWfpSuccess(result, "BuildSecurityDescriptorW(WFP user)");
        blob_.size = bytes;
        blob_.data = static_cast<UINT8*>(descriptor_);
    }

    ~UserCondition() {
        if (descriptor_ != nullptr) LocalFree(descriptor_);
    }

    UserCondition(const UserCondition&) = delete;
    UserCondition& operator=(const UserCondition&) = delete;

    [[nodiscard]] FWP_BYTE_BLOB* blob() noexcept {
        return &blob_;
    }

  private:
    PSECURITY_DESCRIPTOR descriptor_ = nullptr;
    FWP_BYTE_BLOB blob_{};
};

void EnsureProvider(HANDLE engine) {
    std::wstring name = L"mycli Windows Sandbox WFP";
    std::wstring description = L"Persistent provider for mycli Windows sandbox filters";
    FWPM_PROVIDER0 provider{};
    provider.providerKey = kProviderKey;
    provider.displayData.name = name.data();
    provider.displayData.description = description.data();
    provider.flags = kPersistentFlag;
    const DWORD result = FwpmProviderAdd0(engine, &provider, nullptr);
    if (result != ERROR_SUCCESS && !IsWfpResult(result, FWP_E_ALREADY_EXISTS)) {
        RequireWfpSuccess(result, "FwpmProviderAdd0");
    }
}

void EnsureSublayer(HANDLE engine, const GUID& key) {
    std::wstring name = L"mycli Windows Sandbox WFP";
    std::wstring description = L"Persistent sublayer for mycli Windows sandbox filters";
    GUID provider_key = kProviderKey;
    FWPM_SUBLAYER0 sublayer{};
    sublayer.subLayerKey = key;
    sublayer.displayData.name = name.data();
    sublayer.displayData.description = description.data();
    sublayer.flags = static_cast<UINT16>(kPersistentFlag);
    sublayer.providerKey = &provider_key;
    sublayer.weight = 0x8000;
    const DWORD result = FwpmSubLayerAdd0(engine, &sublayer, nullptr);
    if (result != ERROR_SUCCESS && !IsWfpResult(result, FWP_E_ALREADY_EXISTS)) {
        RequireWfpSuccess(result, "FwpmSubLayerAdd0");
    }
}

void DeleteFilterIfPresent(HANDLE engine, const GUID& key) {
    const DWORD result = FwpmFilterDeleteByKey0(engine, &key);
    if (result != ERROR_SUCCESS &&
        !IsWfpResult(result, FWP_E_FILTER_NOT_FOUND) &&
        !IsWfpResult(result, FWP_E_NOT_FOUND)) {
        RequireWfpSuccess(result, "FwpmFilterDeleteByKey0");
    }
}

void AddFilter(HANDLE engine, const FilterSpec& spec, UserCondition& user, const GUID& sublayer) {
    FWPM_FILTER_CONDITION0 condition{};
    condition.fieldKey = kAleUserId;
    condition.matchType = FWP_MATCH_EQUAL;
    condition.conditionValue.type = FWP_SECURITY_DESCRIPTOR_TYPE;
    condition.conditionValue.sd = user.blob();

    std::wstring name = spec.name;
    std::wstring description = L"Block all outbound connections for the mycli offline account";
    GUID provider_key = kProviderKey;
    FWPM_FILTER0 filter{};
    filter.filterKey = spec.key;
    filter.displayData.name = name.data();
    filter.displayData.description = description.data();
    filter.flags = kPersistentFlag;
    filter.providerKey = &provider_key;
    filter.layerKey = *spec.layer;
    filter.subLayerKey = sublayer;
    UINT64 weight = 1;
    filter.weight.type = FWP_UINT64;
    filter.weight.uint64 = &weight;
    filter.numFilterConditions = 1;
    filter.filterCondition = &condition;
    filter.action.type = FWP_ACTION_BLOCK;
    filter.effectiveWeight.type = FWP_EMPTY;
    UINT64 id = 0;
    RequireWfpSuccess(FwpmFilterAdd0(engine, &filter, nullptr, &id), "FwpmFilterAdd0");
}

bool DescriptorMatchesSid(const FWP_BYTE_BLOB* blob, PSID expected_sid) {
    if (blob == nullptr || blob->data == nullptr || blob->size == 0) return false;
    const auto descriptor = static_cast<PSECURITY_DESCRIPTOR>(blob->data);
    if (IsValidSecurityDescriptor(descriptor) == 0 ||
        GetSecurityDescriptorLength(descriptor) > blob->size) return false;
    BOOL present = FALSE;
    BOOL defaulted = FALSE;
    PACL dacl = nullptr;
    if (GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted) == 0 ||
        present == FALSE || dacl == nullptr || dacl->AceCount != 1) {
        return false;
    }
    for (DWORD index = 0; index < dacl->AceCount; ++index) {
        void* raw_ace = nullptr;
        if (GetAce(dacl, index, &raw_ace) == 0) return false;
        const auto* header = static_cast<ACE_HEADER*>(raw_ace);
        if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) continue;
        const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw_ace);
        const PSID sid = const_cast<DWORD*>(&ace->SidStart);
        if ((ace->Mask & FWP_ACTRL_MATCH_FILTER) != 0 &&
            EqualSid(sid, expected_sid) != 0) {
            return true;
        }
    }
    return false;
}

bool FilterReady(HANDLE engine, const FilterSpec& spec, PSID expected_sid, const GUID& sublayer) {
    FWPM_FILTER0* filter = nullptr;
    if (FwpmFilterGetByKey0(engine, &spec.key, &filter) != ERROR_SUCCESS ||
        filter == nullptr) {
        return false;
    }
    bool ready = filter->providerKey != nullptr &&
        IsEqualGUID(*filter->providerKey, kProviderKey) != 0 &&
        IsEqualGUID(filter->layerKey, *spec.layer) != 0 &&
        IsEqualGUID(filter->subLayerKey, sublayer) != 0 &&
        (filter->flags & kPersistentFlag) != 0 &&
        filter->action.type == FWP_ACTION_BLOCK &&
        filter->weight.type == FWP_UINT64 && filter->weight.uint64 != nullptr &&
        *filter->weight.uint64 == 1 &&
        filter->numFilterConditions == 1 &&
        filter->filterCondition != nullptr;
    if (ready) {
        const auto& condition = filter->filterCondition[0];
        ready = IsEqualGUID(condition.fieldKey, kAleUserId) != 0 &&
            condition.matchType == FWP_MATCH_EQUAL &&
            condition.conditionValue.type == FWP_SECURITY_DESCRIPTOR_TYPE &&
            DescriptorMatchesSid(condition.conditionValue.sd, expected_sid);
    }
    FwpmFreeMemory0(reinterpret_cast<void**>(&filter));
    return ready;
}

void PermitProxy(HANDLE engine, const GUID& sublayer, PSID logon_sid, unsigned short port) {
    UserCondition user{logon_sid};
    std::array<FWPM_FILTER_CONDITION0, 4> conditions{};
    conditions[0].fieldKey = kAleUserId;
    conditions[0].conditionValue.type = FWP_SECURITY_DESCRIPTOR_TYPE;
    conditions[0].conditionValue.sd = user.blob();
    conditions[1].fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
    conditions[1].conditionValue.type = FWP_UINT32;
    conditions[1].conditionValue.uint32 = 0x7f000001;
    conditions[2].fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
    conditions[2].conditionValue.type = FWP_UINT16;
    conditions[2].conditionValue.uint16 = port;
    conditions[3].fieldKey = FWPM_CONDITION_IP_PROTOCOL;
    conditions[3].conditionValue.type = FWP_UINT8;
    conditions[3].conditionValue.uint8 = 6; // TCP only.
    for (auto& condition : conditions) condition.matchType = FWP_MATCH_EQUAL;
    std::wstring name = L"mycli Sandbox - Process-owned proxy";
    GUID provider = kProviderKey;
    UINT64 weight = 100;
    FWPM_FILTER0 filter{};
    filter.displayData.name = name.data();
    filter.providerKey = &provider;
    filter.layerKey = kAleAuthConnectV4;
    filter.subLayerKey = sublayer;
    filter.weight.type = FWP_UINT64;
    filter.weight.uint64 = &weight;
    filter.numFilterConditions = static_cast<UINT32>(conditions.size());
    filter.filterCondition = conditions.data();
    // A normal permit overrides this sublayer's default block only. Other
    // Windows firewall policy can still deny the connection.
    filter.action.type = FWP_ACTION_PERMIT;
    UINT64 id = 0;
    RequireWfpSuccess(FwpmFilterAdd0(engine, &filter, nullptr, &id), "FwpmFilterAdd0(proxy)");
}

}  // namespace

void SetupOfflineWfp(const std::wstring& offline_sid) {
    auto sid = SidFromString(offline_sid);
    Engine engine;
    Transaction transaction{engine.get()};
    EnsureProvider(engine.get());
    const auto sublayer = SublayerKey(offline_sid);
    EnsureSublayer(engine.get(), sublayer);
    UserCondition user{sid.get()};
    for (const auto& spec : FilterSpecs(offline_sid)) {
        DeleteFilterIfPresent(engine.get(), spec.key);
        AddFilter(engine.get(), spec, user, sublayer);
    }
    transaction.Commit();
}

bool OfflineWfpReady(const std::wstring& offline_sid) {
    auto sid = SidFromString(offline_sid);
    Engine engine;
    for (const auto& spec : FilterSpecs(offline_sid)) {
        if (!FilterReady(engine.get(), spec, sid.get(), SublayerKey(offline_sid))) return false;
    }
    return true;
}

void SetupProxyWfp(const std::wstring& account_sid, const std::wstring& owner_sid) {
    SetupOfflineWfp(account_sid);
    const auto owner = SidFromString(owner_sid);
    Engine engine;
    GrantWfpProxyAccess(engine.get(), kProviderKey, SublayerKey(account_sid), owner.get());
}

bool ProxyWfpReady(const std::wstring& account_sid, const std::wstring& owner_sid) {
    if (!OfflineWfpReady(account_sid)) return false;
    const auto owner = SidFromString(owner_sid);
    Engine engine;
    return HasWfpProxyAccess(engine.get(), kProviderKey, SublayerKey(account_sid), owner.get());
}

NetworkProxySession::NetworkProxySession(
    HANDLE process, const std::wstring& account_sid, unsigned short port) {
    if (port == 0) throw std::invalid_argument("network proxy port must not be zero");
    HANDLE raw_token = nullptr;
    if (OpenProcessToken(process, TOKEN_QUERY, &raw_token) == 0) {
        throw Win32Error("OpenProcessToken(proxy logon)");
    }
    const UniqueHandle token{raw_token};
    auto logon_sid = CopyTokenLogonSid(token.get());
    Engine engine{true};
    PermitProxy(engine.get(), SublayerKey(account_sid), logon_sid.data(), port);
    engine_ = engine.release();
}

NetworkProxySession::~NetworkProxySession() {
    if (engine_ != nullptr) FwpmEngineClose0(engine_);
}

}  // namespace mycli::sandbox
