#include <algorithm>
#include <exception>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>

#include "protocol.hpp"
#include "sandbox.hpp"

namespace {

constexpr wchar_t kHelperName[] = L"mycli-windows-sandbox";

int Run(int argc, wchar_t* argv[]) {
    if (argc == 2 && std::wstring_view{argv[1]} == L"--handshake") {
        std::wcout << L"{\"name\":\"" << kHelperName
                   << L"\",\"protocol_version\":"
                   << mycli::sandbox::kProtocolVersion
                   << L",\"sandbox_ready\":false}\n";
        return 0;
    }
    if (argc == 3 && std::wstring_view{argv[1]} == L"--request-json") {
        const auto request = mycli::sandbox::ParseAndValidateRequest(argv[2]);
        return static_cast<int>(mycli::sandbox::RunSandboxRequest(request));
    }
    throw std::runtime_error("expected --handshake or --request-json <json>");
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
    try {
        return std::clamp(Run(argc, argv), 0, 255);
    } catch (const std::exception& error) {
        std::cerr << "mycli Windows sandbox error: " << error.what() << '\n';
    }
    return 1;
}
