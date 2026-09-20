#include "psec.hpp"

#include <bit>
#include <limits>
#include <stdexcept>

#include <ProcessSecurityEnvironment_generated.h>

#include "win32.hpp"

namespace mycli::sandbox {
namespace schema = ProcessSecurityEnvironmentLayout;
namespace {

using CreateEnvironment = HRESULT(WINAPI*)(LPCVOID, DWORD, DWORD, HANDLE*);
using QuerySupport = HRESULT(WINAPI*)(ULONGLONG*);
using CloseEnvironment = void(WINAPI*)(HANDLE);

struct PsecApi {
    HMODULE module = nullptr;
    CreateEnvironment create = nullptr;
    QuerySupport query = nullptr;
    CloseEnvironment close = nullptr;

    PsecApi() {
        module = LoadLibraryExW(L"processmodel.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (module == nullptr) return;
        create = std::bit_cast<CreateEnvironment>(GetProcAddress(module, "CreateProcessSecurityEnvironment"));
        query = std::bit_cast<QuerySupport>(GetProcAddress(module, "QueryProcessSecurityEnvironmentSupport"));
        close = std::bit_cast<CloseEnvironment>(GetProcAddress(module, "CloseProcessSecurityEnvironment"));
    }
    ~PsecApi() { if (module != nullptr) FreeLibrary(module); }
    PsecApi(const PsecApi&) = delete;
    PsecApi& operator=(const PsecApi&) = delete;
};

const PsecApi& Api() {
    static const PsecApi api;
    return api;
}

void CheckHresult(HRESULT result, const char* operation) {
    if (FAILED(result)) {
        throw std::runtime_error(std::string{operation} + " failed: " +
            std::to_string(static_cast<unsigned long>(result)));
    }
}

std::string Utf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (size == 0) throw Win32Error("PSEC path encoding");
    std::string result(static_cast<std::size_t>(size), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
            static_cast<int>(value.size()), result.data(), size, nullptr, nullptr) != size) {
        throw Win32Error("PSEC path encoding");
    }
    return result;
}

auto Paths(flatbuffers::FlatBufferBuilder& builder, const std::vector<std::wstring>& paths) {
    std::vector<flatbuffers::Offset<flatbuffers::String>> strings;
    strings.reserve(paths.size());
    for (const auto& path : paths) strings.push_back(builder.CreateString(Utf8(path)));
    return builder.CreateVector(strings);
}

schema::IpProtocol RuleProtocol(NetworkRuleProtocol protocol) {
    switch (protocol) {
        case NetworkRuleProtocol::kAny: return schema::IpProtocol::any;
        case NetworkRuleProtocol::kTcp: return schema::IpProtocol::tcp;
        case NetworkRuleProtocol::kUdp: return schema::IpProtocol::udp;
        case NetworkRuleProtocol::kIcmpV4: return schema::IpProtocol::icmpv4;
        case NetworkRuleProtocol::kIcmpV6: return schema::IpProtocol::icmpv6;
    }
    return schema::IpProtocol::any;
}

flatbuffers::Offset<schema::IpSubnet> RuleSubnet(
    flatbuffers::FlatBufferBuilder& builder, const std::wstring& cidr) {
    const auto separator = cidr.find(L'/');
    const auto address = cidr.substr(0, separator);
    const auto prefix = std::stoi(cidr.substr(separator + 1));
    return schema::CreateIpSubnet(builder, builder.CreateString(Utf8(address)),
        static_cast<std::uint8_t>(prefix));
}

flatbuffers::Offset<schema::EndpointRule> EgressRule(
    flatbuffers::FlatBufferBuilder& builder, const NetworkEgressRule& rule) {
    std::vector<flatbuffers::Offset<schema::DestinationRule>> destinations;
    destinations.reserve(rule.destinations.size());
    for (const auto& destination : rule.destinations) {
        std::vector<flatbuffers::Offset<schema::IpSubnet>> except;
        except.reserve(destination.except.size());
        for (const auto& value : destination.except) except.push_back(RuleSubnet(builder, value));
        destinations.push_back(schema::CreateDestinationRule(builder, RuleSubnet(builder, destination.cidr),
            except.empty() ? flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<schema::IpSubnet>>>{}
                : builder.CreateVector(except)));
    }
    std::vector<flatbuffers::Offset<schema::PortRule>> ports;
    ports.reserve(rule.ports.size());
    for (const auto& port : rule.ports) {
        ports.push_back(schema::CreatePortRule(builder, RuleProtocol(port.protocol), port.port, port.end_port));
    }
    return schema::CreateEndpointRule(builder, builder.CreateVector(destinations),
        builder.CreateVector(ports));
}

flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<schema::EndpointRule>>> EgressRules(
    flatbuffers::FlatBufferBuilder& builder, const std::vector<NetworkEgressRule>& rules) {
    std::vector<flatbuffers::Offset<schema::EndpointRule>> built;
    built.reserve(rules.size());
    for (const auto& rule : rules) built.push_back(EgressRule(builder, rule));
    return builder.CreateVector(built);
}

}  // namespace

std::vector<std::uint8_t> BuildPsecSpecification(const PsecPolicy& policy) {
    flatbuffers::FlatBufferBuilder builder;
    const auto reads = Paths(builder, policy.read_roots);
    const auto writes = Paths(builder, policy.write_roots);
    const auto denies = Paths(builder, policy.denied_roots);
    const bool proxied = policy.proxy_port != 0;
    const auto capabilities = builder.CreateString(proxied
        ? "registryRead,internetClient,networkLoopback" : policy.network_enabled
            ? "registryRead,internetClient,privateNetworkClientServer,networkLoopback" : "registryRead");
    const auto peer = policy.network_enabled || proxied ? builder.CreateString("MXC-Loopback")
        : flatbuffers::Offset<flatbuffers::String>{};
    flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<schema::EndpointRule>>> allows;
    flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<schema::EndpointRule>>> denied_rules;
    schema::FilterAction egress_default = policy.network_enabled && !proxied
        ? schema::FilterAction::allow : schema::FilterAction::deny;
    if (policy.network_egress.has_value()) {
        egress_default = policy.network_egress->allow_default
            ? schema::FilterAction::allow : schema::FilterAction::deny;
        allows = EgressRules(builder, policy.network_egress->allow);
        denied_rules = EgressRules(builder, policy.network_egress->deny);
    } else if (proxied) {
        const auto address = builder.CreateString(policy.allow_local_binding ? "127.0.0.0" : "127.0.0.1");
        const auto subnet = schema::CreateIpSubnet(builder, address, policy.allow_local_binding ? 8 : 32);
        const auto destination = schema::CreateDestinationRule(builder, subnet);
        std::vector<flatbuffers::Offset<schema::DestinationRule>> destination_list{destination};
        if (policy.allow_local_binding) {
            const auto ipv6 = builder.CreateString("::1");
            const auto ipv6_subnet = schema::CreateIpSubnet(builder, ipv6, 128);
            destination_list.push_back(schema::CreateDestinationRule(builder, ipv6_subnet));
        }
        const auto destinations = builder.CreateVector(destination_list);
        const auto port = schema::CreatePortRule(builder, schema::IpProtocol::tcp, policy.proxy_port);
        const auto ports = policy.allow_local_binding
            ? flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<schema::PortRule>>>{}
            : builder.CreateVector(std::vector{port});
        const auto rule = schema::CreateEndpointRule(builder, destinations, ports);
        allows = builder.CreateVector(std::vector{rule});
    }
    const auto egress = schema::CreateEndpointPolicy(builder, egress_default, allows, denied_rules);
    const auto network = schema::CreateNetworkPolicy(builder, {}, egress, peer);
    const schema::SchemaVersion version{1, 0};
    // Permit Win32k/desktop handles for PowerShell, retain clipboard/system/input restrictions.
    const auto specification = schema::CreateProcessSecurityEnvironment(builder, &version,
        capabilities, false, 0x03fe, writes, reads, denies, network);
    schema::FinishProcessSecurityEnvironmentBuffer(builder, specification);
    return {builder.GetBufferPointer(), builder.GetBufferPointer() + builder.GetSize()};
}

PsecEnvironment::PsecEnvironment(std::span<const std::uint8_t> specification) {
    const auto& api = Api();
    if (api.create == nullptr || api.query == nullptr || api.close == nullptr) {
        throw std::runtime_error("psec_api_unavailable");
    }
    ULONGLONG support = 0;
    CheckHresult(api.query(&support), "PSEC support query");
    if ((support & 1) == 0) throw std::runtime_error("psec_deny_unavailable");
    if (specification.empty() || specification.size() > std::numeric_limits<DWORD>::max()) {
        throw std::runtime_error("psec_invalid_specification_size");
    }
    CheckHresult(api.create(specification.data(), static_cast<DWORD>(specification.size()),
        0, &handle_), "PSEC create");
    if (handle_ == nullptr) throw std::runtime_error("psec_invalid_environment");
}

PsecEnvironment::~PsecEnvironment() {
    if (handle_ != nullptr) Api().close(handle_);
}

bool PsecAvailable() noexcept {
    try {
        const PsecEnvironment environment{BuildPsecSpecification({})};
        SIZE_T bytes = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
        if (bytes == 0) return false;
        std::vector<std::uintptr_t> storage((bytes + sizeof(std::uintptr_t) - 1) / sizeof(std::uintptr_t));
        const auto attributes = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        if (InitializeProcThreadAttributeList(attributes, 1, 0, &bytes) == 0) return false;
        HANDLE handle = environment.get();
        const BOOL updated = UpdateProcThreadAttribute(attributes, 0, kSecurityEnvironmentAttribute,
            &handle, sizeof(handle), nullptr, nullptr);
        DeleteProcThreadAttributeList(attributes);
        return updated != 0;
    } catch (...) {
        return false;
    }
}

}  // namespace mycli::sandbox
