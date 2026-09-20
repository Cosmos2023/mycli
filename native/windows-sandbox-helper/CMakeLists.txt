cmake_minimum_required(VERSION 3.24)

project(mycli_windows_sandbox LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "mycli-windows-sandbox can only be built for Windows")
endif()

include(cmake/psec-schema.cmake)

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
        advapi32 bcrypt crypt32 fwpuclnt netapi32 ole32 oleaut32 rpcrt4 shell32 shlwapi user32 userenv uuid ws2_32)

    if(MSVC)
        target_compile_options(${target_name} PRIVATE /W4 /WX /permissive- /utf-8)
    endif()
endfunction()

add_executable(mycli-windows-sandbox
    src/acl.cpp
    src/audit.cpp
    src/desktop.cpp
    src/path-guard.cpp
    src/psec.cpp
    src/psec-policy.cpp
    src/psec-request-paths.cpp
    src/psec-paths.cpp
    src/psec-state.cpp
    src/state.cpp
    src/elevation.cpp
    src/firewall.cpp
    src/identity.cpp
    src/main.cpp
    src/maintenance.cpp
    src/process.cpp
    src/protocol.cpp
    src/sandbox.cpp
    src/sid.cpp
    src/token.cpp
    src/wfp.cpp
    src/wfp-access.cpp
)
mycli_configure_windows_target(mycli-windows-sandbox)
mycli_configure_psec_target(mycli-windows-sandbox)

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
    src/audit.cpp
    src/desktop.cpp
    src/path-guard.cpp
    src/psec.cpp
    src/psec-policy.cpp
    src/psec-request-paths.cpp
    src/psec-paths.cpp
    src/state.cpp
    src/firewall.cpp
    src/identity.cpp
    src/process.cpp
    src/sandbox.cpp
    src/sid.cpp
    src/token.cpp
    src/wfp.cpp
    src/wfp-access.cpp
)
mycli_configure_windows_target(mycli-windows-sandbox-primitives-tests)
mycli_configure_psec_target(mycli-windows-sandbox-primitives-tests)
add_test(NAME windows_primitives COMMAND mycli-windows-sandbox-primitives-tests)
set_tests_properties(windows_primitives PROPERTIES TIMEOUT 60)

add_executable(mycli-windows-sandbox-probe tests/sandbox_probe.cpp)
mycli_configure_windows_target(mycli-windows-sandbox-probe)
target_link_libraries(mycli-windows-sandbox-probe PRIVATE ws2_32)

add_executable(mycli-windows-sandbox-audit-tests
    tests/windows_audit_tests.cpp
    src/acl.cpp
    src/audit.cpp
    src/path-guard.cpp
    src/state.cpp
    src/sid.cpp
)
mycli_configure_windows_target(mycli-windows-sandbox-audit-tests)
add_test(NAME windows_host_audit COMMAND mycli-windows-sandbox-audit-tests)
set_tests_properties(windows_host_audit PROPERTIES TIMEOUT 30)

add_executable(mycli-windows-sandbox-psec-tests
    tests/windows_psec_tests.cpp src/psec.cpp src/psec-policy.cpp src/psec-paths.cpp src/psec-request-paths.cpp src/process.cpp src/desktop.cpp
    src/identity.cpp src/sid.cpp src/token.cpp src/wfp.cpp src/wfp-access.cpp
    src/path-guard.cpp src/state.cpp src/acl.cpp)
mycli_configure_windows_target(mycli-windows-sandbox-psec-tests)
mycli_configure_psec_target(mycli-windows-sandbox-psec-tests)
# Explicit opt-in on hosts with PSEC. An unsupported host must not turn this gate into a skip.
option(MYCLI_REQUIRE_PSEC_TESTS "Require real PSEC enforcement tests" OFF)
if(MYCLI_REQUIRE_PSEC_TESTS)
    add_test(NAME windows_psec COMMAND mycli-windows-sandbox-psec-tests)
    set_tests_properties(windows_psec PROPERTIES TIMEOUT 45)
endif()
