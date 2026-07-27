#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <filesystem>
#include <fstream>
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

int Listen(const std::filesystem::path& port_file) {
    Winsock winsock;
    const SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) return 31;
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = 0;
    if (bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR ||
        listen(listener, 1) == SOCKET_ERROR) {
        closesocket(listener);
        return 32;
    }
    int address_bytes = sizeof(address);
    if (getsockname(listener, reinterpret_cast<sockaddr*>(&address), &address_bytes) == SOCKET_ERROR) {
        closesocket(listener);
        return 33;
    }
    std::ofstream output{port_file, std::ios::trunc};
    output << ntohs(address.sin_port);
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

int Connect(unsigned short port) {
    Winsock winsock;
    const SOCKET client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (client == INVALID_SOCKET) return 36;
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(port);
    const int result = connect(
        client, reinterpret_cast<sockaddr*>(&address), sizeof(address));
    closesocket(client);
    return result == 0 ? 0 : 37;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
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
        return Listen(argv[2]);
    }
    if (argc == 3 && std::wstring_view{argv[1]} == L"--connect") {
        return Connect(static_cast<unsigned short>(std::stoul(argv[2])));
    }
    return 2;
}
