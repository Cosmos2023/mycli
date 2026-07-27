#include <algorithm>
#include <exception>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>

#include <winrt/base.h>

#include "protocol.hpp"

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
        static_cast<void>(request);
        throw std::runtime_error(
            "restricted-token and ACL enforcement are not installed");
    }
    throw std::runtime_error("expected --handshake or --request-json <json>");
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
    try {
        winrt::init_apartment();
        return std::clamp(Run(argc, argv), 0, 255);
    } catch (const winrt::hresult_error& error) {
        std::wcerr << L"mycli Windows sandbox error: " << error.message().c_str() << L'\n';
    } catch (const std::exception& error) {
        std::cerr << "mycli Windows sandbox error: " << error.what() << '\n';
    }
    return 1;
}
