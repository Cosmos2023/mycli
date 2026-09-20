#pragma once

#include "psec.hpp"

namespace mycli::sandbox {
// Requires the owner's setup lock and active journal in production.
void PreparePsecPaths(PsecPolicy& policy);
std::wstring CreatePsecTemporaryDirectory();
}
