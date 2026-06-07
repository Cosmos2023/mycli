from __future__ import annotations

import json

from mycli.evaluation.provider_quirk_matrix import provider_quirk_matrix_rows


def main() -> int:
    print(
        json.dumps(
            {
                "evaluation": "provider_quirk_matrix",
                "network": "not_used",
                "rows": provider_quirk_matrix_rows(),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
