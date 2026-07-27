#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <string_view>

namespace {

class Winsock {
  public:
    Winsock() {
        WSADATA data{};
        if (WSAStartup(MAKEWORD(2, 2), &data) != 0) throw 30;
    }
    ~Winsock() { WSACleanup(); }
};

int Listen(const std::filesystem::path& port_file, int family) {
    Winsock winsock;
    const SOCKET listener = socket(family, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) return 31;
    sockaddr_storage storage{};
    int address_bytes = 0;
    if (family == AF_INET6) {
        auto* address = reinterpret_cast<sockaddr_in6*>(&storage);
        address->sin6_family = AF_INET6;
        address->sin6_addr = in6addr_loopback;
        address->sin6_port = 0;
        address_bytes = sizeof(*address);
    } else {
        auto* address = reinterpret_cast<sockaddr_in*>(&storage);
        address->sin_family = AF_INET;
        address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        address->sin_port = 0;
        address_bytes = sizeof(*address);
    }
    if (bind(listener, reinterpret_cast<sockaddr*>(&storage), address_bytes) == SOCKET_ERROR ||
        listen(listener, 1) == SOCKET_ERROR) {
        closesocket(listener);
        return 32;
    }
    if (getsockname(
            listener,
            reinterpret_cast<sockaddr*>(&storage),
            &address_bytes) == SOCKET_ERROR) {
        closesocket(listener);
        return 33;
    }
    const auto port = family == AF_INET6
        ? reinterpret_cast<const sockaddr_in6*>(&storage)->sin6_port
        : reinterpret_cast<const sockaddr_in*>(&storage)->sin_port;
    std::ofstream output{port_file, std::ios::trunc};
    output << ntohs(port);
    output.close();
    if (!output) {
        closesocket(listener);
        return 34;
    }
    const SOCKET client = accept(listener, nullptr, nullptr);
    if (client != INVALID_SOCKET) closesocket(client);
    closesocket(listener);
    return client == INVALID_SOCKET ? 35 : 0;
}

int Connect(unsigned short port, int family) {
    Winsock winsock;
    const SOCKET client = socket(family, SOCK_STREAM, IPPROTO_TCP);
    if (client == INVALID_SOCKET) return 36;
    sockaddr_storage storage{};
    int address_bytes = 0;
    if (family == AF_INET6) {
        auto* address = reinterpret_cast<sockaddr_in6*>(&storage);
        address->sin6_family = AF_INET6;
        address->sin6_addr = in6addr_loopback;
        address->sin6_port = htons(port);
        address_bytes = sizeof(*address);
    } else {
        auto* address = reinterpret_cast<sockaddr_in*>(&storage);
        address->sin_family = AF_INET;
        address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        address->sin_port = htons(port);
        address_bytes = sizeof(*address);
    }
    const int result = connect(
        client, reinterpret_cast<sockaddr*>(&storage), address_bytes);
    closesocket(client);
    return result == 0 ? 0 : 37;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
    if (argc == 2 && std::wstring_view{argv[1]} == L"--stdio") {
        std::cout << "sandbox-stdout-ok\n" << std::flush;
        std::cerr << "sandbox-stderr-ok\n" << std::flush;
        return 0;
    }
    if (argc == 3 && std::wstring_view{argv[1]} == L"--write-file") {
        std::ofstream output{std::filesystem::path{argv[2]}};
        output << "ok";
        return output ? 0 : 10;
    }
    if (argc == 3 && std::wstring_view{argv[1]} == L"--read-file") {
        std::ifstream input{std::filesystem::path{argv[2]}};
        std::string value;
        input >> value;
        return input ? 0 : 11;
    }
    if (argc == 3 && std::wstring_view{argv[1]} == L"--listen") {
        return Listen(argv[2], AF_INET);
    }
    if (argc == 3 && std::wstring_view{argv[1]} == L"--listen6") {
        return Listen(argv[2], AF_INET6);
    }
    if (argc == 3 && std::wstring_view{argv[1]} == L"--connect") {
        return Connect(static_cast<unsigned short>(std::stoul(argv[2])), AF_INET);
    }
    if (argc == 3 && std::wstring_view{argv[1]} == L"--connect6") {
        return Connect(static_cast<unsigned short>(std::stoul(argv[2])), AF_INET6);
    }
    return 2;
}
