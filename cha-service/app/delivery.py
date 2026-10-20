"""Delivering the file to the tracker — only when CHA has set DELIVERY_URL.

    POST <DELIVERY_URL>
    Content-Type: application/json
    Authorization: Bearer <DELIVERY_TOKEN>

The body is the file's exact bytes. The tracker stores a snapshot once however
many times it arrives (keyed by snapshot_id), so retrying is always safe.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

import requests

from .redcap import describe_body

# Seconds to wait before the second and third attempts. A nightly job can
# afford to wait out a brief outage or a sleeping web service.
RETRY_DELAYS = (30.0, 120.0)
TIMEOUT = 60.0
_MAX_TRACKER_MESSAGE = 500


@dataclass(frozen=True)
class DeliveryResult:
    ok: bool
    message: str


def _tracker_message(res: requests.Response) -> str:
    """The tracker's own explanation, e.g. which field the contract does not define."""
    try:
        parsed = res.json()
    except ValueError:
        return describe_body(res.text)
    if isinstance(parsed, dict):
        err = parsed.get("error")
        if isinstance(err, dict):
            err = err.get("message")
        for candidate in (err, parsed.get("message")):
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()[:_MAX_TRACKER_MESSAGE]
    return "no explanation given"


def deliver(
    body: bytes,
    url: str,
    token: str,
    *,
    session: requests.Session | None = None,
    delays: tuple[float, ...] = RETRY_DELAYS,
    sleep: Callable[[float], None] = time.sleep,
    timeout: float = TIMEOUT,
) -> DeliveryResult:
    session = session or requests.Session()
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    attempts = len(delays) + 1
    last = "no attempt was made"
    for attempt in range(attempts):
        if attempt:
            sleep(delays[attempt - 1])
        try:
            # No redirects: following one would resend the file somewhere
            # DELIVERY_URL does not name.
            res = session.post(url, data=body, headers=headers, timeout=timeout, allow_redirects=False)
        except requests.Timeout:
            last = f"the tracker did not respond within {timeout:g}s"
            continue
        except requests.RequestException as exc:
            last = f"could not reach the tracker ({type(exc).__name__})"
            continue

        code = res.status_code
        if 200 <= code < 300:
            try:
                already = res.json().get("status") == "already_stored"
            except (ValueError, AttributeError):
                already = False
            return DeliveryResult(True, "already stored by the tracker" if already else "stored by the tracker")
        if code in (401, 403):
            return DeliveryResult(False, f"the tracker did not accept DELIVERY_TOKEN (HTTP {code})")
        if code == 429 or code >= 500:
            last = f"the tracker returned HTTP {code}"
            continue
        if 300 <= code < 400:
            return DeliveryResult(False, f"the tracker redirected the request (HTTP {code}); check DELIVERY_URL")
        return DeliveryResult(False, f"the tracker refused the file (HTTP {code}): {_tracker_message(res)}")
    return DeliveryResult(False, f"{last}, after {attempts} attempts")
