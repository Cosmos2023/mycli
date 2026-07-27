#include "firewall.hpp"

#include <windows.h>
#include <initguid.h>
#include <netfw.h>
#include <oleauto.h>

#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <utility>

namespace mycli::sandbox {
namespace {

constexpr wchar_t kRuleNamePrefix[] = L"mycli_sandbox_offline_block_outbound_";
constexpr wchar_t kRuleDescription[] = L"mycli Sandbox Offline";
constexpr LONG kAnyIpProtocol = 256;

std::filesystem::path MarkerPath(const std::filesystem::path& state_directory) {
    return state_directory / L"firewall.v1";
}

void ValidateSidString(const std::wstring& sid) {
    if (!sid.starts_with(L"S-1-5-") ||
        sid.find_first_not_of(L"S-0123456789-") != std::wstring::npos) {
        throw std::runtime_error("offline account SID has an invalid format");
    }
}

std::string SidAscii(const std::wstring& sid) {
    ValidateSidString(sid);
    std::string ascii;
    ascii.reserve(sid.size());
    for (const wchar_t character : sid) {
        ascii.push_back(static_cast<char>(character));
    }
    return ascii;
}

std::wstring RuleName(const std::wstring& offline_sid) {
    ValidateSidString(offline_sid);
    return std::wstring{kRuleNamePrefix} + offline_sid;
}

std::wstring LocalUserSddl(const std::wstring& offline_sid) {
    ValidateSidString(offline_sid);
    return L"O:LSD:(A;;CC;;;" + offline_sid + L")";
}

[[noreturn]] void ThrowComError(const char* operation, HRESULT result) {
    throw std::runtime_error(
        std::string{operation} + " failed with HRESULT " +
        std::to_string(static_cast<unsigned long>(result)));
}

void RequireComSuccess(HRESULT result, const char* operation) {
    if (FAILED(result)) ThrowComError(operation, result);
}

class ComApartment {
  public:
    ComApartment() {
        const HRESULT result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        if (FAILED(result)) ThrowComError("CoInitializeEx(firewall)", result);
        initialized_ = true;
    }

    ~ComApartment() {
        if (initialized_) CoUninitialize();
    }

    ComApartment(const ComApartment&) = delete;
    ComApartment& operator=(const ComApartment&) = delete;

  private:
    bool initialized_ = false;
};

template <typename Interface>
class ComPtr {
  public:
    ComPtr() noexcept = default;
    explicit ComPtr(Interface* value) noexcept : value_{value} {}
    ~ComPtr() {
        reset();
    }

    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;

    ComPtr(ComPtr&& other) noexcept : value_{other.release()} {}
    ComPtr& operator=(ComPtr&& other) noexcept {
        if (this != &other) reset(other.release());
        return *this;
    }

    [[nodiscard]] Interface* get() const noexcept {
        return value_;
    }

    [[nodiscard]] Interface** put() noexcept {
        reset();
        return &value_;
    }

    [[nodiscard]] Interface* operator->() const noexcept {
        return value_;
    }

    [[nodiscard]] Interface* release() noexcept {
        Interface* value = value_;
        value_ = nullptr;
        return value;
    }

    void reset(Interface* value = nullptr) noexcept {
        if (value_ != nullptr) value_->Release();
        value_ = value;
    }

  private:
    Interface* value_ = nullptr;
};

class BStr {
  public:
    explicit BStr(const std::wstring& value) : value_{SysAllocString(value.c_str())} {
        if (value_ == nullptr) throw std::bad_alloc{};
    }

    explicit BStr(const wchar_t* value) : value_{SysAllocString(value)} {
        if (value_ == nullptr) throw std::bad_alloc{};
    }

    ~BStr() {
        if (value_ != nullptr) SysFreeString(value_);
    }

    BStr(const BStr&) = delete;
    BStr& operator=(const BStr&) = delete;

    [[nodiscard]] BSTR get() const noexcept {
        return value_;
    }

  private:
    BSTR value_ = nullptr;
};

ComPtr<INetFwPolicy2> OpenFirewallPolicy() {
    ComPtr<INetFwPolicy2> policy;
    RequireComSuccess(
        CoCreateInstance(
            CLSID_NetFwPolicy2,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_INetFwPolicy2,
            reinterpret_cast<void**>(policy.put())),
        "CoCreateInstance(NetFwPolicy2)");
    NET_FW_MODIFY_STATE modify_state{};
    const HRESULT result = policy->get_LocalPolicyModifyState(&modify_state);
    if (result != S_OK || modify_state != NET_FW_MODIFY_STATE_OK) {
        throw std::runtime_error(
            "local firewall policy does not accept effective sandbox rules");
    }
    return policy;
}

ComPtr<INetFwRules> OpenFirewallRules(INetFwPolicy2* policy) {
    ComPtr<INetFwRules> rules;
    RequireComSuccess(policy->get_Rules(rules.put()), "INetFwPolicy2::get_Rules");
    return rules;
}

void ConfigureRule(INetFwRule3* rule, const std::wstring& offline_sid) {
    const BStr description{kRuleDescription};
    const BStr remote_addresses{L"*"};
    const BStr local_user{LocalUserSddl(offline_sid)};
    RequireComSuccess(rule->put_Description(description.get()), "firewall put_Description");
    RequireComSuccess(rule->put_Protocol(kAnyIpProtocol), "firewall put_Protocol");
    RequireComSuccess(
        rule->put_RemoteAddresses(remote_addresses.get()),
        "firewall put_RemoteAddresses");
    RequireComSuccess(rule->put_Direction(NET_FW_RULE_DIR_OUT), "firewall put_Direction");
    RequireComSuccess(rule->put_Action(NET_FW_ACTION_BLOCK), "firewall put_Action");
    RequireComSuccess(rule->put_Enabled(VARIANT_TRUE), "firewall put_Enabled");
    RequireComSuccess(rule->put_Profiles(NET_FW_PROFILE2_ALL), "firewall put_Profiles");
    RequireComSuccess(
        rule->put_LocalUserAuthorizedList(local_user.get()),
        "firewall put_LocalUserAuthorizedList");
}

bool RuleMatches(INetFwRule3* rule, const std::wstring& offline_sid) {
    LONG protocol = 0;
    LONG profiles = 0;
    NET_FW_RULE_DIRECTION direction{};
    NET_FW_ACTION action{};
    VARIANT_BOOL enabled = VARIANT_FALSE;
    BSTR raw_local_user = nullptr;
    RequireComSuccess(rule->get_Protocol(&protocol), "firewall get_Protocol");
    RequireComSuccess(rule->get_Profiles(&profiles), "firewall get_Profiles");
    RequireComSuccess(rule->get_Direction(&direction), "firewall get_Direction");
    RequireComSuccess(rule->get_Action(&action), "firewall get_Action");
    RequireComSuccess(rule->get_Enabled(&enabled), "firewall get_Enabled");
    RequireComSuccess(
        rule->get_LocalUserAuthorizedList(&raw_local_user),
        "firewall get_LocalUserAuthorizedList");
    const std::wstring local_user = raw_local_user == nullptr
        ? std::wstring{}
        : std::wstring{raw_local_user, SysStringLen(raw_local_user)};
    if (raw_local_user != nullptr) SysFreeString(raw_local_user);
    return protocol == kAnyIpProtocol &&
        profiles == NET_FW_PROFILE2_ALL &&
        direction == NET_FW_RULE_DIR_OUT &&
        action == NET_FW_ACTION_BLOCK &&
        enabled == VARIANT_TRUE &&
        local_user.find(offline_sid) != std::wstring::npos;
}

ComPtr<INetFwRule3> FindRule(INetFwRules* rules, const std::wstring& name) {
    const BStr rule_name{name};
    ComPtr<INetFwRule> base_rule;
    if (FAILED(rules->Item(rule_name.get(), base_rule.put()))) return {};
    ComPtr<INetFwRule3> rule;
    RequireComSuccess(
        base_rule->QueryInterface(
            IID_INetFwRule3,
            reinterpret_cast<void**>(rule.put())),
        "firewall QueryInterface(INetFwRule3)");
    return rule;
}

ComPtr<INetFwRule3> EnsureRule(
    INetFwRules* rules,
    const std::wstring& name,
    const std::wstring& offline_sid) {
    auto rule = FindRule(rules, name);
    if (rule.get() != nullptr) {
        ConfigureRule(rule.get(), offline_sid);
        return rule;
    }
    RequireComSuccess(
        CoCreateInstance(
            CLSID_NetFwRule,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_INetFwRule3,
            reinterpret_cast<void**>(rule.put())),
        "CoCreateInstance(NetFwRule)");
    const BStr rule_name{name};
    RequireComSuccess(rule->put_Name(rule_name.get()), "firewall put_Name");
    ConfigureRule(rule.get(), offline_sid);
    RequireComSuccess(
        rules->Add(static_cast<INetFwRule*>(rule.get())),
        "INetFwRules::Add");
    return rule;
}

bool LiveFirewallRuleReady(const std::wstring& offline_sid) {
    const ComApartment apartment;
    auto policy = OpenFirewallPolicy();
    auto rules = OpenFirewallRules(policy.get());
    auto rule = FindRule(rules.get(), RuleName(offline_sid));
    return rule.get() != nullptr && RuleMatches(rule.get(), offline_sid);
}

}  // namespace

void SetupOfflineFirewall(
    const std::wstring& offline_sid,
    const std::filesystem::path& state_directory) {
    const ComApartment apartment;
    auto policy = OpenFirewallPolicy();
    auto rules = OpenFirewallRules(policy.get());
    auto rule = EnsureRule(rules.get(), RuleName(offline_sid), offline_sid);
    if (!RuleMatches(rule.get(), offline_sid)) {
        throw std::runtime_error("offline firewall rule read-back verification failed");
    }
    std::filesystem::create_directories(state_directory);
    std::ofstream marker{MarkerPath(state_directory), std::ios::binary | std::ios::trunc};
    marker << SidAscii(offline_sid) << '\n';
    marker.close();
    if (!marker) throw std::runtime_error("failed to persist firewall setup marker");
}

bool OfflineFirewallSetupReady(
    const std::wstring& offline_sid,
    const std::filesystem::path& state_directory) {
    std::ifstream marker{MarkerPath(state_directory), std::ios::binary};
    std::string stored;
    std::getline(marker, stored);
    if ((!marker.good() && !marker.eof()) || stored != SidAscii(offline_sid)) return false;
    return LiveFirewallRuleReady(offline_sid);
}

}  // namespace mycli::sandbox
