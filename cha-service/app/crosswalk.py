"""Crosswalks: REDCap data access group -> CHA ID, one file per program.

    app/crosswalk.<program>.json
    { "some_dag": { "cha_id": "428", "hospital": "Some Hospital" } }

`hospital` is for human readability only; `cha_id` is the join key the
tracker uses. A malformed crosswalk fails that program's run as a
configuration error — it never runs on a partial mapping, which would read
as the missing hospitals not having submitted.
"""
from __future__ import annotations

import json
from pathlib import Path

CROSSWALK_DIR = Path(__file__).parent


class CrosswalkError(ValueError):
    pass


def load_crosswalk(program: str, directory: Path = CROSSWALK_DIR) -> dict[str, str]:
    path = directory / f"crosswalk.{program.lower()}.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise CrosswalkError(f"No crosswalk file for {program} ({path.name}).") from None
    except (OSError, ValueError) as exc:
        raise CrosswalkError(f"{path.name} could not be read as JSON ({type(exc).__name__}).") from None

    if not isinstance(raw, dict) or not raw:
        raise CrosswalkError(f"{path.name} must be a non-empty JSON object keyed by data access group.")

    out: dict[str, str] = {}
    owner: dict[str, str] = {}
    for dag, entry in raw.items():
        dag = str(dag).strip()
        cha_id = entry.get("cha_id") if isinstance(entry, dict) else None
        # Integers are accepted for convenience; the file format is a string.
        if isinstance(cha_id, int) and not isinstance(cha_id, bool):
            cha_id = str(cha_id)
        if not dag or not isinstance(cha_id, str) or not cha_id.strip():
            raise CrosswalkError(f'{path.name}: entry "{dag}" needs a non-empty "cha_id".')
        cha_id = cha_id.strip()
        # Two groups claiming one hospital would merge their data silently.
        if cha_id in owner:
            raise CrosswalkError(
                f'{path.name}: "{owner[cha_id]}" and "{dag}" both map to CHA ID {cha_id}.'
            )
        owner[cha_id] = dag
        out[dag] = cha_id
    return out
