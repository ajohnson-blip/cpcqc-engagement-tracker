"""Crosswalks: REDCap data access group -> CHA ID, one file per program.

    app/crosswalk.<program>.json
    {
      "some_dag":  { "cha_id": "EX-001", "hospital": "Some Hospital" },
      "other_dag": { "cha_id": "EX-002", "hospital": "Other Hospital", "tracked": false }
    }

`hospital` is for human readability only; `cha_id` is the join key the
tracker uses. `"tracked": false` marks a hospital that is known but not
tracked for this program — in SOAR, the sustainability-track and not-enrolled
hospitals, which have no monthly tasks. Their rows are skipped silently, so a
warning fires only for a data access group nobody has listed. When a hospital
joins the active cohort, remove `"tracked": false`.

A malformed crosswalk fails that program's run as a configuration error — it
never runs on a partial mapping, which would read as the missing hospitals not
having submitted.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

CROSSWALK_DIR = Path(__file__).parent


class CrosswalkError(ValueError):
    pass


@dataclass(frozen=True)
class Crosswalk:
    # Tracked data access group -> CHA ID. Only these are assessed.
    cha_ids: dict[str, str]
    # Known data access groups that are not tracked, skipped without a warning.
    untracked: frozenset[str] = frozenset()


def load_crosswalk(program: str, directory: Path = CROSSWALK_DIR) -> Crosswalk:
    path = directory / f"crosswalk.{program.lower()}.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise CrosswalkError(f"No crosswalk file for {program} ({path.name}).") from None
    except (OSError, ValueError) as exc:
        raise CrosswalkError(f"{path.name} could not be read as JSON ({type(exc).__name__}).") from None

    if not isinstance(raw, dict) or not raw:
        raise CrosswalkError(f"{path.name} must be a non-empty JSON object keyed by data access group.")

    cha_ids: dict[str, str] = {}
    untracked: set[str] = set()
    owner: dict[str, str] = {}
    for dag, entry in raw.items():
        dag = str(dag).strip()
        cha_id = entry.get("cha_id") if isinstance(entry, dict) else None
        # Integers are accepted for convenience; the file format is a string.
        if isinstance(cha_id, int) and not isinstance(cha_id, bool):
            cha_id = str(cha_id)
        if not dag or not isinstance(cha_id, str) or not cha_id.strip():
            raise CrosswalkError(f'{path.name}: entry "{dag}" needs a non-empty "cha_id".')
        tracked = entry.get("tracked", True)
        if not isinstance(tracked, bool):
            raise CrosswalkError(f'{path.name}: entry "{dag}" has a "tracked" that is not true or false.')
        cha_id = cha_id.strip()
        # Two groups claiming one hospital would merge their data silently.
        if cha_id in owner:
            raise CrosswalkError(
                f'{path.name}: "{owner[cha_id]}" and "{dag}" both map to CHA ID {cha_id}.'
            )
        owner[cha_id] = dag
        if tracked:
            cha_ids[dag] = cha_id
        else:
            untracked.add(dag)
    if not cha_ids:
        raise CrosswalkError(f"{path.name} tracks no hospital.")
    return Crosswalk(cha_ids=cha_ids, untracked=frozenset(untracked))
