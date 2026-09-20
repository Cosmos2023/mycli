#pragma once

#include "psec.hpp"
#include "protocol.hpp"

namespace mycli::sandbox {
std::vector<std::wstring> SnapshotPsecVolumeRoots(const std::vector<std::wstring>& roots);
PsecPolicy ResolvePsecPolicy(const SandboxRequest& request);
PsecPolicy PreparePsecPolicy(const SandboxRequest& request);
DWORD RunPsecRequest(const SandboxRequest& request);
DWORD RunPsecRequest(const SandboxRequest& request, const PsecPolicy& policy);
}
