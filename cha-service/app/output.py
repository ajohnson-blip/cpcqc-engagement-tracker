"""Writing the file — the only file the script writes.

It is written under a temporary name in OUTPUT_DIR and renamed into place
once complete, so anything watching the directory never sees a half-written
file. The temporary file holds exactly the final file's content; records read
from REDCap are never written anywhere.
"""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path

from .models import Snapshot

FILENAME_PREFIX = "engagement-assessment-"


def filename_for(snapshot: Snapshot) -> str:
    """engagement-assessment-20261020T080512Z.json, from generated_at."""
    stamp = snapshot.generated_at.replace("-", "").replace(":", "")
    return f"{FILENAME_PREFIX}{stamp}.json"


def serialize(snapshot: Snapshot) -> bytes:
    """The file's bytes. Delivery sends these unchanged."""
    return (json.dumps(snapshot.to_dict(), indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def write_file(body: bytes, output_dir: Path, filename: str) -> Path:
    target = output_dir / filename
    if target.exists():
        raise FileExistsError(f"{target} already exists")
    partial = output_dir / f".{filename}.partial"
    try:
        with open(partial, "xb") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(partial, target)
    except BaseException:
        with contextlib.suppress(OSError):
            partial.unlink()
        raise
    return target
