include(FetchContent)

set(FLATBUFFERS_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(FLATBUFFERS_INSTALL OFF CACHE BOOL "" FORCE)
set(FLATBUFFERS_BUILD_FLATLIB OFF CACHE BOOL "" FORCE)
set(FLATBUFFERS_BUILD_SHAREDLIB OFF CACHE BOOL "" FORCE)
FetchContent_Declare(flatbuffers
    URL https://github.com/google/flatbuffers/archive/refs/tags/v25.12.19.tar.gz
    URL_HASH SHA256=f81c3162b1046fe8b84b9a0dbdd383e24fdbcf88583b9cb6028f90d04d90696a
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(flatbuffers)

set(MYCLI_PSEC_SCHEMA "${CMAKE_CURRENT_LIST_DIR}/../third_party/psec/ProcessSecurityEnvironment.fbs")
file(READ "${MYCLI_PSEC_SCHEMA}" MYCLI_PSEC_SCHEMA_TEXT)
string(REPLACE "\r\n" "\n" MYCLI_PSEC_SCHEMA_TEXT "${MYCLI_PSEC_SCHEMA_TEXT}")
string(SHA256 MYCLI_PSEC_SCHEMA_SHA256 "${MYCLI_PSEC_SCHEMA_TEXT}")
if(NOT MYCLI_PSEC_SCHEMA_SHA256 STREQUAL "7d14b01850a735329da00cde4d4d2e32e463f49026a39708be9059fd64e764d3")
    message(FATAL_ERROR "PSEC schema differs from the pinned Microsoft revision")
endif()
set(MYCLI_PSEC_GENERATED "${CMAKE_CURRENT_BINARY_DIR}/psec-generated")
file(MAKE_DIRECTORY "${MYCLI_PSEC_GENERATED}")
add_custom_command(
    OUTPUT "${MYCLI_PSEC_GENERATED}/ProcessSecurityEnvironment_generated.h"
    COMMAND $<TARGET_FILE:flatc> --cpp --scoped-enums -o "${MYCLI_PSEC_GENERATED}" "${MYCLI_PSEC_SCHEMA}"
    DEPENDS flatc "${MYCLI_PSEC_SCHEMA}"
    VERBATIM)
add_custom_target(mycli-psec-schema DEPENDS "${MYCLI_PSEC_GENERATED}/ProcessSecurityEnvironment_generated.h")

function(mycli_configure_psec_target target_name)
    add_dependencies(${target_name} mycli-psec-schema)
    target_include_directories(${target_name} SYSTEM PRIVATE
        "${flatbuffers_SOURCE_DIR}/include" "${MYCLI_PSEC_GENERATED}")
endfunction()
