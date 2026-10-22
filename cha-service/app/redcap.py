"""REDCap API client.

Two deliberate constraints, both carried over from the tracker's own client:

Minimum necessary. `export_records` takes an explicit field list and sends no
`forms` parameter. REDCap returns the UNION of named fields and every field on
a named form, so passing both restricts nothing — the field list has to stand
alone. Request only what the assessment actually reads.

Error messages never echo the response body. A malformed 200 would otherwise
put the first bytes of the record array into an exception and from there into
the output file or a log. Describe the shape, never the content.

Records are returned to the caller in memory and never written anywhere.
"""
from __future__ import annotations

import re

import requests

# REDCap's own error strings describe the request ("You do not have API
# rights"), not record data, so they are passed on — but capped, in case a
# misbehaving proxy returns something long under an "error" key.
_MAX_REDCAP_MESSAGE = 300


class RedcapError(RuntimeError):
    pass


def describe_body(text: str) -> str:
    """Characterise a response body without reproducing any of it."""
    n = len(text)
    head = text.lstrip()[:1]
    if n == 0:
        return "an empty response"
    if head == "<":
        return f"{n} bytes of HTML — a proxy or login page probably intercepted the request"
    if head in "{[":
        return f"{n} bytes of JSON-like content that failed to parse"
    return f"{n} bytes of unrecognised content"


def _redcap_message(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()[:_MAX_REDCAP_MESSAGE]
    return None


class RedcapClient:
    def __init__(self, api_url: str, timeout: float, session: requests.Session | None = None):
        self.api_url = api_url
        self.timeout = timeout
        self._session = session or requests.Session()

    def _post(self, token: str, data: dict[str, str]) -> list[dict]:
        body = {"token": token, "format": "json", "returnFormat": "json", **data}
        try:
            res = self._session.post(self.api_url, data=body, timeout=self.timeout)
        except requests.Timeout:
            raise RedcapError(f"REDCap did not respond within {self.timeout:g}s") from None
        except requests.RequestException as exc:
            # The class name only: requests' messages can include the URL and
            # connection detail, which is noise in a file sent to the tracker.
            raise RedcapError(f"Could not reach REDCap ({type(exc).__name__})") from None

        text = res.text
        if res.status_code >= 400:
            try:
                message = _redcap_message(res.json().get("error"))
            except (ValueError, AttributeError):
                message = None
            if message:
                raise RedcapError(f"REDCap rejected the request (HTTP {res.status_code}): {message}")
            raise RedcapError(f"REDCap returned HTTP {res.status_code} with {describe_body(text)}")

        try:
            parsed = res.json()
        except ValueError:
            raise RedcapError(f"REDCap returned non-JSON: {describe_body(text)}") from None

        if isinstance(parsed, dict):
            message = _redcap_message(parsed.get("error"))
            if message:
                raise RedcapError(f"REDCap error: {message}")
            raise RedcapError("REDCap returned an object where a list of records was expected")
        if not isinstance(parsed, list):
            raise RedcapError("REDCap did not return a list of records")
        return parsed

    def export_records(
        self, token: str, fields: list[str], include_record_id: bool = True
    ) -> list[dict]:
        """Records, restricted to named fields.

        No `forms` parameter by design — see the module docstring. Checkbox
        fields are named by their base name; REDCap expands them to
        `field___<code>`.

        `record_id` is requested by default, as the tracker does, because
        naming it brings REDCap's structural columns (repeat instrument, data
        access group) back. It is held in memory only and never written. Pass
        False for a project whose record-ID field has another name — naming a
        field that does not exist makes REDCap reject the whole export.
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
        return self._post(token, data)

    def export_metadata(self, token: str) -> list[dict]:
        """The project's data dictionary. Raises RedcapError if it cannot be read."""
        return self._post(token, {"content": "metadata"})

    def export_field_labels(self, token: str) -> dict[str, str]:
        """field_name -> human label, from the live data dictionary.

        Best effort: a failure here must not stop an assessment. Callers fall
        back to the variable name, which still identifies the field
        unambiguously.
        """
        try:
            return labels_from_metadata(self.export_metadata(token))
        except RedcapError:
            return {}


def labels_from_metadata(meta: list[dict]) -> dict[str, str]:
    """field_name -> label, with the rich-text markup dictionary labels often carry removed."""
    labels: dict[str, str] = {}
    for m in meta:
        if not isinstance(m, dict):
            continue
        name = str(m.get("field_name", "")).strip()
        label = re.sub(r"<[^>]*>", "", str(m.get("field_label", ""))).strip()
        if name and label:
            labels[name] = label
    return labels
