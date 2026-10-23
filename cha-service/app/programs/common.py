"""Helpers every program's rules share.

Each mirrors the tracker's own helper of the same purpose, so the programs
agree with the tracker field for field.
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import date
from typing import Iterable

from ..models import MissingField, MissingFieldGroup

_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def is_filled(value) -> bool:
    return value is not None and str(value).strip() != ""


def is_valid_date(value) -> bool:
    """A submission date is usable only when it is a real ISO calendar date.

    Junk typed into the field must not be treated as a submission date. One
    deliberate difference from the tracker: its JavaScript date parser rolls
    an impossible day like 2026-02-30 over into March and accepts it; this
    rejects it. @TODAY cannot produce such a value, so the two can only
    disagree on a corrupted entry.
    """
    if not is_filled(value):
        return False
    s = str(value).strip()[:10]
    if not _ISO_DATE.fullmatch(s):
        return False
    try:
        date.fromisoformat(s)
    except ValueError:
        return False
    return True


def checkbox_filled(row: dict, prefix: str) -> bool:
    """REDCap exports checkboxes as `field___1`, `field___2`… Filled = any checked."""
    return any(
        k.startswith(f"{prefix}___") and str(v).strip() == "1" for k, v in row.items()
    )


def checkbox_includes(row: dict, prefix: str, option: str) -> bool:
    return str(row.get(f"{prefix}___{option}", "")).strip() == "1"


def group_missing(
    entries: Iterable[tuple[str, list[str]]], labels: dict[str, str]
) -> tuple[MissingFieldGroup, ...]:
    """Group by (form, exact field set), counting records per pattern.

    One record missing eight fields is an abandoned entry; eight records each
    missing one is a systematic gap. Those warrant different conversations, and
    a flat per-field tally cannot tell them apart because both produce the same
    totals. Grouping preserves the distinction without naming any record.
    """
    buckets: dict[tuple[str, tuple[str, ...]], int] = defaultdict(int)
    for form, fields in entries:
        if fields:
            buckets[(form, tuple(sorted(fields)))] += 1
    # Most-incomplete pattern first, then the most widespread — as the
    # tracker orders them. Form and fields break ties so output is stable.
    ordered = sorted(buckets.items(), key=lambda kv: (-len(kv[0][1]), -kv[1], kv[0]))
    return tuple(
        MissingFieldGroup(
            form=form,
            records=count,
            fields=tuple(MissingField(field=f, label=labels.get(f, f)) for f in fields),
        )
        for (form, fields), count in ordered
    )


def plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"
