"""One run of the script: every configured program, every program year in scope.

Each program succeeds or fails on its own. A REDCap outage for one program
becomes an error entry for that program, and the others still land.
"""
from __future__ import annotations

import traceback
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Callable

from . import GENERATOR_NAME, __version__
from .config import Config
from .crosswalk import CROSSWALK_DIR, CrosswalkError, load_crosswalk
from .errors import ProjectConfigurationError
from .models import Run, Snapshot, Source
from .programs import IMPLEMENTED
from .redcap import RedcapClient, RedcapError


def describe_exception(exc: BaseException) -> str:
    """The exception's type and where it was raised — never its message.

    An unexpected error's message can quote the value that caused it
    (`invalid literal for int(): '…'`), and that value may come from a record.
    The code location is enough to find the defect.
    """
    frames = traceback.extract_tb(exc.__traceback__)
    if not frames:
        return type(exc).__name__
    last = frames[-1]
    return f"{type(exc).__name__} at {Path(last.filename).name}:{last.lineno} in {last.name}"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def run_program(
    module: ModuleType,
    config: Config,
    client: RedcapClient,
    today: date,
    crosswalk_dir: Path = CROSSWALK_DIR,
) -> list[Run]:
    program = module.PROGRAM
    years = config.program_years

    def failed(code: str, message: str) -> list[Run]:
        return [Run.failed(program, year, code, message) for year in years]

    try:
        crosswalk = load_crosswalk(program, crosswalk_dir)
    except CrosswalkError as exc:
        return failed("configuration", str(exc))

    try:
        fetched = module.fetch(client, config.tokens)
    except RedcapError as exc:
        return failed("redcap_unavailable", str(exc))
    except ProjectConfigurationError as exc:
        return failed("configuration", str(exc))
    except Exception as exc:  # one program's defect must not stop the others
        return failed("internal", f"Unexpected error while reading REDCap ({describe_exception(exc)}).")

    source = Source(records_read=fetched.records_read, redcap_project=module.REDCAP_PROJECT)
    runs: list[Run] = []
    for year in years:
        try:
            assessments, warnings = module.assess_year(fetched, year, crosswalk, today)
        except Exception as exc:
            runs.append(
                Run.failed(program, year, "internal", f"Unexpected error while assessing ({describe_exception(exc)}).")
            )
            continue
        runs.append(Run.ok(program, year, module.METHODOLOGY_VERSION, source, assessments, warnings))
    return runs


def build_snapshot(
    config: Config,
    client: RedcapClient,
    today: date,
    clock: Callable[[], datetime] = _utc_now,
    new_id: Callable[[], uuid.UUID] = uuid.uuid4,
    crosswalk_dir: Path = CROSSWALK_DIR,
) -> Snapshot:
    # Taken before the first REDCap read, so "everything submitted before
    # generated_at is in this file" holds. The tracker relies on that when a
    # month is finalized.
    generated_at = clock().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    runs: list[Run] = []
    for program in config.programs:
        runs.extend(run_program(IMPLEMENTED[program], config, client, today, crosswalk_dir))
    return Snapshot(
        snapshot_id=str(new_id()),
        generated_at=generated_at,
        generator_name=GENERATOR_NAME,
        generator_version=__version__,
        runs=tuple(runs),
    )
