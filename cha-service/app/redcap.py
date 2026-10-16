"""REDCap API client.

Two deliberate constraints, both carried over from the tracker's own client:

Minimum necessary. `export_records` takes an explicit field list and sends no
`forms` parameter. REDCap returns the UNION of named fields and every field on
a named form, so passing both restricts nothing — the field list has to stand
alone. Request only what the assessment actually reads.

Error messages never echo the response body. A malformed 200 would otherwise
put the first bytes of the record array into an exception and from there into
logs. Describe the shape, never the content.
"""
from __future__ import annotations

import httpx

from .config import settings


def _describe(text: str) -> str:
    """Characterise a response body without reproducing any of it."""
    n = len(text)
    head = text.lstrip()[:1]
    if head == "<":
        return f"{n} bytes of HTML — a proxy or login page probably intercepted the request"
    if head in "{[":
        return f"{n} bytes of JSON-like content that failed to parse"
    if n == 0:
        return "empty response"
    return f"{n} bytes of unrecognised content"


class RedcapError(RuntimeError):
    pass


def _post(token: str, data: dict[str, str]) -> list[dict]:
    body = {"token": token, "format": "json", "returnFormat": "json", **data}
    try:
        res = httpx.post(settings.redcap_api_url, data=body, timeout=settings.redcap_timeout)
    except httpx.HTTPError as exc:
        raise RedcapError(f"Could not reach REDCap: {exc.__class__.__name__}") from exc

    text = res.text
    if res.status_code >= 400:
        # REDCap reports its own failures as {"error": "..."} — that text is
        # about the request, never record data, so it is safe to surface.
        try:
            err = res.json().get("error")
            if isinstance(err, str) and err:
                raise RedcapError(f"REDCap rejected the request: {err}")
        except ValueError:
            pass
        raise RedcapError(f"REDCap returned HTTP {res.status_code}: {_describe(text)}")

    try:
        parsed = res.json()
    except ValueError:
        raise RedcapError(f"REDCap returned non-JSON: {_describe(text)}") from None

    if isinstance(parsed, dict) and "error" in parsed:
        raise RedcapError(f"REDCap error: {parsed['error']}")
    if not isinstance(parsed, list):
        raise RedcapError("REDCap did not return a list of records.")
    return parsed


def export_records(token: str, fields: list[str], include_record_id: bool = True) -> list[dict]:
    """Records, restricted to named fields.

    No `forms` parameter by design — see the module docstring. Checkbox fields
    are named by their base name; REDCap expands them to `field___<code>`.
    """
    data: dict[str, str] = {
        "content": "record",
        "type": "flat",
        "rawOrLabel": "raw",
        "exportDataAccessGroups": "true",
    }
    names = (["record_id"] if include_record_id else []) + list(fields)
    for i, name in enumerate(names):
        data[f"fields[{i}]"] = name
    return _post(token, data)


def export_field_labels(token: str) -> dict[str, str]:
    """field_name -> human label, from the live data dictionary.

    Best effort: a failure here must not stop an assessment. Callers fall back
    to the variable name, which still identifies the field unambiguously.
    """
    try:
        meta = _post(token, {"content": "metadata"})
    except RedcapError:
        return {}
    labels: dict[str, str] = {}
    for m in meta:
        name = str(m.get("field_name", "")).strip()
        label = str(m.get("field_label", "")).strip()
        if name and label:
            # Dictionary labels often carry rich-text markup.
            import re
            labels[name] = re.sub(r"<[^>]*>", "", label).strip()
    return labels
