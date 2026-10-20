"""CPCQC engagement assessment — run once a night, after midnight Mountain time.

    python run_assessment.py

Reads REDCap for each configured program, writes one file to OUTPUT_DIR, and
delivers it to the tracker if DELIVERY_URL is set. Configuration: README.md.

Exit codes:
    0  every program succeeded, and delivery succeeded if configured
    1  a program failed, the file could not be written, or delivery failed
    2  configuration error — nothing was run

The log carries counts, warnings and errors — never record content.
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

from app import GENERATOR_NAME, __version__
from app.config import ConfigError, load_config
from app.delivery import deliver
from app.output import filename_for, serialize, write_file
from app.redcap import RedcapClient
from app.runner import build_snapshot

HERE = Path(__file__).resolve().parent
log = logging.getLogger("engagement-assessment")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
    # Values already in the environment win over the file.
    load_dotenv(HERE / ".env")
    # Local date. The script runs on CHA's machines, which keep Mountain time.
    today = date.today()

    try:
        config = load_config(os.environ, today)
    except ConfigError as exc:
        for problem in exc.problems:
            log.error("Configuration: %s", problem)
        log.error("Nothing was run.")
        return 2
    for notice in config.notices:
        log.warning(notice)

    log.info(
        "%s %s: programs %s, program years %s",
        GENERATOR_NAME,
        __version__,
        ", ".join(config.programs),
        ", ".join(str(y) for y in config.program_years),
    )

    client = RedcapClient(config.redcap_api_url, config.redcap_timeout)
    snapshot = build_snapshot(config, client, today)

    failed = False
    for run in snapshot.runs:
        if run.status == "ok":
            log.info(
                "%s %d: ok, %d records read, %d assessments, %d warnings",
                run.program,
                run.program_year,
                run.source.records_read,
                len(run.assessments),
                len(run.warnings),
            )
            for warning in run.warnings:
                log.warning("%s %d: %s", run.program, run.program_year, warning)
        else:
            failed = True
            log.error("%s %d: %s: %s", run.program, run.program_year, run.error.code, run.error.message)

    body = serialize(snapshot)
    try:
        path = write_file(body, config.output_dir, filename_for(snapshot))
    except OSError as exc:
        # CHA's copy is the record of what was sent, so nothing is delivered
        # without it.
        log.error("Could not write the file to OUTPUT_DIR (%s); it was not delivered.", type(exc).__name__)
        return 1
    log.info("Wrote %s (snapshot %s)", path, snapshot.snapshot_id)

    if config.delivery_url:
        result = deliver(body, config.delivery_url, config.delivery_token)
        if result.ok:
            log.info("Delivered: %s.", result.message)
        else:
            failed = True
            log.error("Delivery failed: %s. The file at CHA is unaffected.", result.message)
    else:
        log.info("DELIVERY_URL is not set; the file was not delivered.")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
