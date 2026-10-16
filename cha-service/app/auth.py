"""Bearer-token auth.

A single shared secret, compared in constant time. The service holds REDCap
tokens that reach patient-level projects, so an unauthenticated caller must
never get as far as a REDCap request.
"""
import secrets

from fastapi import Header, HTTPException, status

from .config import settings


def require_token(authorization: str = Header(default="")) -> None:
    if not settings.auth_token:
        # Refuse rather than run open. A missing secret is a deployment
        # mistake, and defaulting to "allow" would be the wrong way to fail.
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            {"error": {"code": "internal", "message": "AUTH_TOKEN is not configured."}},
        )
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(token, settings.auth_token):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            {"error": {"code": "unauthorized", "message": "Missing or invalid bearer token."}},
        )
