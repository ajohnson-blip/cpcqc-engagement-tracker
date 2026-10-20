"""Configuration, all from the environment — or a `.env` file beside the script,
which `run_assessment.py` loads without overriding anything already set.

REDCap tokens are secrets and must never be committed. They are validated for
shape but never echoed, not even in an error message.

Every problem is collected before failing, so one run of the script reports
everything that needs fixing rather than one item at a time.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Mapping
from urllib.parse import urlsplit

from .programs import IMPLEMENTED, KNOWN

DEFAULT_REDCAP_API_URL = "https://redcap.vumc.org/api/"
DEFAULT_REDCAP_TIMEOUT = 90.0
# December's data arrives in January and late submissions trail into
# February, so the previous program year stays in scope for these months.
ROLLOVER_MONTHS = (1, 2)

_TOKEN = re.compile(r"[0-9A-Fa-f]{32}")
_YEAR = re.compile(r"\d{4}")
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class ConfigError(ValueError):
    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("; ".join(problems))


@dataclass(frozen=True)
class Config:
    output_dir: Path
    delivery_url: str | None
    delivery_token: str | None
    redcap_api_url: str
    redcap_timeout: float
    # Only the tokens for programs in scope — a token not needed is not held.
    tokens: dict[str, str]
    programs: tuple[str, ...]
    program_years: tuple[int, ...]
    # Not errors, but worth a line in the log: a program skipped for want of a
    # token, a delivery token with nowhere to deliver.
    notices: tuple[str, ...]

    def __repr__(self) -> str:
        # Never let a token reach a log through a stray print(config).
        return (
            f"Config(output_dir={str(self.output_dir)!r}, delivery={'on' if self.delivery_url else 'off'}, "
            f"programs={self.programs}, program_years={self.program_years})"
        )


def default_program_years(today: date) -> tuple[int, ...]:
    if today.month in ROLLOVER_MONTHS:
        return (today.year - 1, today.year)
    return (today.year,)


def _url_problem(name: str, url: str, allow_local_http: bool) -> str | None:
    parts = urlsplit(url)
    if parts.username or parts.password:
        return f"{name} must not contain credentials."
    if parts.scheme == "https" and parts.hostname:
        return None
    if allow_local_http and parts.scheme == "http" and parts.hostname in _LOCAL_HOSTS:
        return None
    suffix = " (http:// is accepted only for localhost, for testing)" if allow_local_http else ""
    return f"{name} must be an https:// URL{suffix}."


def load_config(environ: Mapping[str, str], today: date) -> Config:
    problems: list[str] = []
    notices: list[str] = []

    def get(name: str) -> str:
        return environ.get(name, "").strip()

    # --- Output: required, and must already exist ---
    output_dir: Path | None = None
    raw = get("OUTPUT_DIR")
    if not raw:
        problems.append("OUTPUT_DIR is required: the directory each night's file is written to.")
    else:
        path = Path(raw).expanduser()
        # Deliberately not created when missing: an unmounted network share
        # would otherwise become an empty local folder, and the files would
        # land somewhere nobody looks.
        if not path.is_dir():
            problems.append(f"OUTPUT_DIR {path} does not exist or is not a directory.")
        elif not os.access(path, os.W_OK):
            problems.append(f"OUTPUT_DIR {path} is not writable by this account.")
        else:
            output_dir = path

    # --- Delivery: optional, CHA's choice ---
    delivery_url = get("DELIVERY_URL") or None
    delivery_token = get("DELIVERY_TOKEN") or None
    if delivery_url:
        problem = _url_problem("DELIVERY_URL", delivery_url, allow_local_http=True)
        if problem:
            problems.append(problem)
        if not delivery_token:
            problems.append("DELIVERY_TOKEN is required when DELIVERY_URL is set.")
    elif delivery_token:
        notices.append("DELIVERY_TOKEN is set but DELIVERY_URL is not; the file will not be delivered.")
        delivery_token = None

    # --- REDCap ---
    api_url = get("REDCAP_API_URL") or DEFAULT_REDCAP_API_URL
    problem = _url_problem("REDCAP_API_URL", api_url, allow_local_http=False)
    if problem:
        problems.append(problem)

    timeout = DEFAULT_REDCAP_TIMEOUT
    raw = get("REDCAP_TIMEOUT")
    if raw:
        try:
            timeout = float(raw)
        except ValueError:
            timeout = -1.0
        if not 1 <= timeout <= 3600:
            problems.append("REDCAP_TIMEOUT must be a number of seconds from 1 to 3600.")

    # --- Programs ---
    raw = get("PROGRAMS")
    explicit = bool(raw)
    if explicit:
        requested: list[str] = []
        for name in (p.strip().upper() for p in raw.split(",")):
            if name and name not in requested:
                requested.append(name)
        for name in requested:
            if name not in KNOWN:
                problems.append(f'PROGRAMS names "{name}", which is not a program. Programs: {", ".join(KNOWN)}.')
            elif name not in IMPLEMENTED:
                problems.append(
                    f"PROGRAMS names {name}, which this version does not implement yet. "
                    f"Implemented: {', '.join(IMPLEMENTED)}."
                )
        if not requested:
            problems.append("PROGRAMS is set but names no program.")
    else:
        requested = list(IMPLEMENTED)

    tokens: dict[str, str] = {}
    programs: list[str] = []
    for name in requested:
        module = IMPLEMENTED.get(name)
        if module is None:
            continue
        missing = []
        for setting in module.TOKEN_SETTINGS:
            value = get(setting)
            if not value:
                missing.append(setting)
            elif not _TOKEN.fullmatch(value):
                problems.append(f"{setting} is not a 32-character REDCap API token.")
            else:
                tokens[setting] = value
        if missing:
            # Asked for by name, a missing token is a mistake; by default, it
            # just means the program has not been set up here yet.
            if explicit:
                problems.append(f"PROGRAMS includes {name}, but {', '.join(missing)} is not set.")
            else:
                notices.append(f"{name} skipped: {', '.join(missing)} is not set.")
        else:
            programs.append(name)
    if not programs and not problems:
        problems.append("No program has its REDCap token configured, so there is nothing to run.")

    # --- Program years ---
    raw = get("PROGRAM_YEARS")
    if raw:
        years: set[int] = set()
        for part in (p.strip() for p in raw.split(",")):
            if not part:
                continue
            if not _YEAR.fullmatch(part):
                problems.append(f'PROGRAM_YEARS: "{part}" is not a year.')
            elif int(part) > today.year:
                # Nothing can be assessed for a year that has not started.
                problems.append(f"PROGRAM_YEARS: {part} has not started yet.")
            else:
                years.add(int(part))
        if not years and not any(p.startswith("PROGRAM_YEARS") for p in problems):
            problems.append("PROGRAM_YEARS is set but names no year.")
        program_years = tuple(sorted(years))
    else:
        program_years = default_program_years(today)

    if problems:
        raise ConfigError(problems)
    assert output_dir is not None
    return Config(
        output_dir=output_dir,
        delivery_url=delivery_url,
        delivery_token=delivery_token,
        redcap_api_url=api_url,
        redcap_timeout=timeout,
        tokens=tokens,
        programs=tuple(programs),
        program_years=program_years,
        notices=tuple(notices),
    )
