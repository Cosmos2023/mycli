cmake_minimum_required(VERSION 3.24)

project(mycli_windows_sandbox LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "mycli-windows-sandbox can only be built for Windows")
endif()

function(mycli_configure_windows_target target_name)
    target_compile_features(${target_name} PRIVATE cxx_std_20)
    target_compile_definitions(${target_name} PRIVATE
        NOMINMAX
        UNICODE
        _UNICODE
        WIN32_LEAN_AND_MEAN
    )
    target_include_directories(${target_name} PRIVATE src third_party)
    target_link_libraries(${target_name} PRIVATE
        advapi32 bcrypt crypt32 netapi32 ole32 oleaut32 shell32 shlwapi uuid)

    if(MSVC)
        target_compile_options(${target_name} PRIVATE /W4 /WX /permissive- /utf-8)
    endif()
endfunction()

add_executable(mycli-windows-sandbox
    src/acl.cpp
    src/elevation.cpp
    src/firewall.cpp
    src/identity.cpp
    src/main.cpp
    src/process.cpp
    src/protocol.cpp
    src/sandbox.cpp
    src/sid.cpp
    src/token.cpp
)
mycli_configure_windows_target(mycli-windows-sandbox)

enable_testing()
add_executable(mycli-windows-sandbox-protocol-tests
    tests/protocol_tests.cpp
    src/protocol.cpp
)
mycli_configure_windows_target(mycli-windows-sandbox-protocol-tests)
add_test(NAME protocol COMMAND mycli-windows-sandbox-protocol-tests)
set_tests_properties(protocol PROPERTIES TIMEOUT 30)

add_executable(mycli-windows-sandbox-primitives-tests
    tests/windows_primitives_tests.cpp
    src/acl.cpp
    src/identity.cpp
    src/process.cpp
    src/sandbox.cpp
    src/sid.cpp
    src/token.cpp
)
mycli_configure_windows_target(mycli-windows-sandbox-primitives-tests)
add_test(NAME windows_primitives COMMAND mycli-windows-sandbox-primitives-tests)
set_tests_properties(windows_primitives PROPERTIES TIMEOUT 60)

add_executable(mycli-windows-sandbox-probe tests/sandbox_probe.cpp)
mycli_configure_windows_target(mycli-windows-sandbox-probe)
target_link_libraries(mycli-windows-sandbox-probe PRIVATE ws2_32)
