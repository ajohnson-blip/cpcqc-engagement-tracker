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

TtT's file has its own shape — see `load_ttt_crosswalk`.

A malformed crosswalk fails that program's run as a configuration error — it
never runs on a partial mapping, which would read as the missing hospitals not
having submitted.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
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


@dataclass(frozen=True)
class TttCrosswalk:
    """TtT's projects spell some hospitals' groups differently, so each project
    has its own map, and they are joined on CHA ID."""
    # Hospital-project data access group -> CHA ID.
    hospital_dags: dict[str, str]
    # Patient-project data access group -> CHA ID. Two groups may share one.
    patient_dags: dict[str, str]
    # CHoSEN Dyadic data access group -> CHA ID, for a hospital that enters its
    # patient forms there instead.
    dyadic_dags: dict[str, str]
    # Groups in the shared projects that are not TtT hospitals, skipped
    # without a warning.
    not_hospitals: frozenset[str] = frozenset()
    # CHA ID -> the file's `hospital`, to make a warning readable.
    hospital_names: dict[str, str] = field(default_factory=dict)

    def describe(self, cha_id: str) -> str:
        name = self.hospital_names.get(cha_id)
        return f"{name} (CHA ID {cha_id})" if name else f"CHA ID {cha_id}"


def _read(path: Path, program: str):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise CrosswalkError(f"No crosswalk file for {program} ({path.name}).") from None
    except (OSError, ValueError) as exc:
        raise CrosswalkError(f"{path.name} could not be read as JSON ({type(exc).__name__}).") from None


def _cha_id(value) -> str | None:
    # Integers are accepted for convenience; the file format is a string.
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def load_crosswalk(program: str, directory: Path = CROSSWALK_DIR) -> Crosswalk | TttCrosswalk:
    if program == "TTT":
        return load_ttt_crosswalk(directory)
    path = directory / f"crosswalk.{program.lower()}.json"
    raw = _read(path, program)

    if not isinstance(raw, dict) or not raw:
        raise CrosswalkError(f"{path.name} must be a non-empty JSON object keyed by data access group.")

    cha_ids: dict[str, str] = {}
    untracked: set[str] = set()
    owner: dict[str, str] = {}
    for dag, entry in raw.items():
        dag = str(dag).strip()
        cha_id = _cha_id(entry.get("cha_id")) if isinstance(entry, dict) else None
        if not dag or cha_id is None:
            raise CrosswalkError(f'{path.name}: entry "{dag}" needs a non-empty "cha_id".')
        tracked = entry.get("tracked", True)
        if not isinstance(tracked, bool):
            raise CrosswalkError(f'{path.name}: entry "{dag}" has a "tracked" that is not true or false.')
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


_TTT_KEYS = {"hospitals", "not_hospitals"}
_TTT_ENTRY_KEYS = {"cha_id", "hospital", "hospital_dag", "patient_dags", "dyadic_dag"}


def load_ttt_crosswalk(directory: Path = CROSSWALK_DIR) -> TttCrosswalk:
    """TtT's crosswalk, keyed by hospital rather than by group:

        app/crosswalk.ttt.json
        {
          "hospitals": [
            { "cha_id": "EX-001", "hospital": "Some Hospital",
              "hospital_dag": "some_hosp", "patient_dags": ["some_hospital_pt"] },
            { "cha_id": "EX-002", "hospital": "Other Hospital",
              "hospital_dag": "other", "patient_dags": ["other"], "dyadic_dag": "other_dyad" }
          ],
          "not_hospitals": ["another_collaborative", "test"]
        }

    `hospital_dag` is the hospital's group in the hospital project, or null
    if it has none; `patient_dags` its groups in the patient project — two
    when one CHA ID covers two groups there. `dyadic_dag` names its group in
    the CHoSEN Dyadic project, for a hospital that enters its patient forms
    there. `not_hospitals` lists groups in the shared projects that are not
    TtT hospitals, so they are skipped without a warning.

    Every listed hospital is assessed. Which of them are in this year's
    cohort is the tracker's decision, from its TtT enrollment. Unknown keys
    are refused, so a misspelt one cannot silently map nothing.
    """
    path = directory / "crosswalk.ttt.json"
    raw = _read(path, "TTT")
    if not isinstance(raw, dict) or not isinstance(raw.get("hospitals"), list) or not raw["hospitals"]:
        raise CrosswalkError(f'{path.name} must be a JSON object with a non-empty "hospitals" list.')
    extra = sorted(set(raw) - _TTT_KEYS)
    if extra:
        raise CrosswalkError(f"{path.name}: unknown key {', '.join(extra)}.")

    maps: dict[str, dict[str, str]] = {"hospital": {}, "patient": {}, "dyadic": {}}
    names: dict[str, str] = {}
    seen: set[str] = set()

    def dag_name(value, where: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise CrosswalkError(f"{path.name}: {where} must be a non-empty data access group name.")
        return value.strip()

    for i, entry in enumerate(raw["hospitals"], start=1):
        if not isinstance(entry, dict):
            raise CrosswalkError(f"{path.name}: hospitals entry {i} is not an object.")
        cha_id = _cha_id(entry.get("cha_id"))
        if cha_id is None:
            raise CrosswalkError(f'{path.name}: hospitals entry {i} needs a non-empty "cha_id".')
        where = f"CHA ID {cha_id}"
        if cha_id in seen:
            raise CrosswalkError(f"{path.name}: {where} is listed twice.")
        seen.add(cha_id)
        extra = sorted(set(entry) - _TTT_ENTRY_KEYS)
        if extra:
            raise CrosswalkError(f"{path.name}: {where} has unknown key {', '.join(extra)}.")

        hospital_dag = entry.get("hospital_dag")
        patient_dags = entry.get("patient_dags", [])
        dyadic_dag = entry.get("dyadic_dag")
        if not isinstance(patient_dags, list):
            raise CrosswalkError(f'{path.name}: {where} has a "patient_dags" that is not a list.')
        groups = {
            "hospital": [] if hospital_dag is None else [dag_name(hospital_dag, f"{where}'s hospital_dag")],
            "patient": [dag_name(d, f"each of {where}'s patient_dags") for d in patient_dags],
            "dyadic": [] if dyadic_dag is None else [dag_name(dyadic_dag, f"{where}'s dyadic_dag")],
        }
        if not any(groups.values()):
            raise CrosswalkError(f"{path.name}: {where} names no data access group.")
        if isinstance(entry.get("hospital"), str) and entry["hospital"].strip():
            names[cha_id] = entry["hospital"].strip()
        for project, dags in groups.items():
            for dag in dags:
                # One group credited to two hospitals would count its data twice.
                if dag in maps[project]:
                    raise CrosswalkError(
                        f'{path.name}: {project}-project group "{dag}" is listed for CHA ID '
                        f"{maps[project][dag]} and {cha_id}."
                    )
                maps[project][dag] = cha_id

    not_hospitals = raw.get("not_hospitals", [])
    if not isinstance(not_hospitals, list):
        raise CrosswalkError(f'{path.name}: "not_hospitals" must be a list.')
    skipped = {dag_name(d, "each of not_hospitals") for d in not_hospitals}
    both = sorted(skipped & (maps["hospital"].keys() | maps["patient"].keys()))
    if both:
        raise CrosswalkError(f'{path.name}: "{both[0]}" is listed both as a hospital\'s group and in not_hospitals.')

    return TttCrosswalk(
        hospital_dags=maps["hospital"],
        patient_dags=maps["patient"],
        dyadic_dags=maps["dyadic"],
        not_hospitals=frozenset(skipped),
        hospital_names=names,
    )
