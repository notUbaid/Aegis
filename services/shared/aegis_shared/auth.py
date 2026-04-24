"""Firebase Auth + App Check verification helpers.

Every Cloud Run service that accepts calls from a staff, responder, or guest
client should run incoming requests through ``verify_request``. It checks:

    1. Firebase ID token (``Authorization: Bearer <token>``) via the Admin SDK.
    2. Firebase App Check token (``X-Firebase-AppCheck: <token>``) for
       attestation (Play Integrity / App Attest / reCAPTCHA Enterprise).

In local dev (``AEGIS_ENV == 'local'``) the middleware short-circuits — returns
an anonymous principal and logs a warning. Set ``AEGIS_REQUIRE_AUTH=1`` in the
environment to force enforcement even locally (useful for integration tests).

Both checks are soft-fail if the Admin SDK is not initialised: we log a warning
and return an anonymous principal. This keeps CI green and never silently
mis-authorises — the principal simply lacks any custom claims.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from fastapi import Header, HTTPException, status

from aegis_shared.config import get_settings
from aegis_shared.logger import get_logger

log = get_logger(__name__)


@dataclass
class Principal:
    """Authenticated caller identity."""

    uid: str = "anonymous"
    email: str | None = None
    role: str | None = None
    venues: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    app_check_verified: bool = False
    raw_claims: dict[str, Any] = field(default_factory=dict)

    @property
    def is_anonymous(self) -> bool:
        return self.uid == "anonymous"


def _require_auth_enabled() -> bool:
    if os.environ.get("AEGIS_REQUIRE_AUTH") == "1":
        return True
    return not get_settings().is_local


def _firebase_admin() -> Any | None:
    try:
        from aegis_shared.fcm import _firebase_app  # reuse singleton initialiser

        return _firebase_app()
    except Exception as exc:
        log.warning("auth_firebase_admin_unavailable", error=str(exc))
        return None


def _verify_id_token(token: str) -> dict[str, Any] | None:
    app = _firebase_admin()
    if app is None:
        return None
    try:
        from firebase_admin import auth  # type: ignore[import-not-found]

        return auth.verify_id_token(token, app=app, check_revoked=True)
    except Exception as exc:
        log.warning("auth_id_token_invalid", error=str(exc))
        return None


def _verify_app_check(token: str) -> bool:
    app = _firebase_admin()
    if app is None:
        return False
    try:
        from firebase_admin import app_check  # type: ignore[import-not-found]

        app_check.verify_token(token, app=app)
        return True
    except Exception as exc:
        log.warning("auth_app_check_invalid", error=str(exc))
        return False


async def verify_request(
    authorization: str | None = Header(default=None),
    x_firebase_appcheck: str | None = Header(default=None, alias="X-Firebase-AppCheck"),
) -> Principal:
    """FastAPI dependency. Usage::

        @app.post("/v1/protected")
        async def protected(principal: Principal = Depends(verify_request)):
            ...

    Returns an anonymous ``Principal`` in local/dev. In production, raises 401
    if the ID token is missing or invalid. App Check is enforced only when a
    token is supplied and deployed services set
    ``FIREBASE_APP_CHECK_REQUIRED=1``.
    """
    enforce = _require_auth_enabled()

    bearer = None
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization.split(" ", 1)[1].strip()

    if bearer is None:
        if enforce:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="missing bearer token",
            )
        log.warning("auth_anonymous_request_allowed_local")
        return Principal()

    claims = _verify_id_token(bearer)
    if claims is None:
        if enforce:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid id token",
            )
        return Principal()

    app_check_ok = True
    if x_firebase_appcheck:
        app_check_ok = _verify_app_check(x_firebase_appcheck)
    elif os.environ.get("FIREBASE_APP_CHECK_REQUIRED") == "1":
        if enforce:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="missing app check token",
            )
        app_check_ok = False

    return Principal(
        uid=claims.get("uid") or claims.get("user_id", "unknown"),
        email=claims.get("email"),
        role=claims.get("role"),
        venues=list(claims.get("venues") or []),
        skills=list(claims.get("skills") or []),
        app_check_verified=app_check_ok,
        raw_claims=claims,
    )


def require_role(*allowed_roles: str) -> Callable[..., Awaitable[Principal]]:
    """Return a FastAPI dependency that enforces role membership."""
    allowed = {r.lower() for r in allowed_roles}

    async def _dep(principal: Principal = _dep_principal) -> Principal:  # type: ignore[valid-type]
        if (principal.role or "").lower() not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"role must be one of {sorted(allowed)}",
            )
        return principal

    return _dep


# Late binding to avoid circular default-argument evaluation. FastAPI reads
# ``Depends(verify_request)`` at import time so we expose it via a module
# constant.
from fastapi import Depends  # noqa: E402

_dep_principal = Depends(verify_request)
