"""Security-related FastAPI middleware and headers."""

from __future__ import annotations

from typing import Callable

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from aegis_shared.config import get_settings


def apply_security_middleware(app: FastAPI) -> None:
    """Apply CORS and security headers middleware to the FastAPI app.

    Order matters: CORS must come first (per FastAPI docs), then security headers.
    """
    settings = get_settings()

    # 1. CORS — must be first to handle preflight properly
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allowed_origins,
        allow_credentials=False,  # Never allow credentials with wildcard origins
        allow_methods=["GET", "POST", "OPTIONS", "PUT", "DELETE", "PATCH"],
        allow_headers=["*"],  # Allow all headers; tighten if needed
        expose_headers=["X-Request-ID"],  # For client-side debugging
    )

    # 2. Security headers — added after CORS so they apply to all responses
    app.add_middleware(SecurityHeadersMiddleware)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Inject security headers into every response."""

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        response = await call_next(request)

        # Content Security Policy — restrict resource loading
        # Adjust `default-src` based on your frontend origins
        csp_directives = [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",  # Next.js needs inline for dev; tighten for prod
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https:",
            "font-src 'self' data:",
            "connect-src 'self'",  # API calls; add backend URLs if different origin
            "frame-ancestors 'none'",  # Prevent clickjacking
        ]
        response.headers["Content-Security-Policy"] = "; ".join(csp_directives)

        # Prevent MIME-sniffing
        response.headers["X-Content-Type-Options"] = "nosniff"

        # Clickjack protection
        response.headers["X-Frame-Options"] = "DENY"

        # HSTS — force HTTPS for 1 year (only in production)
        settings = get_settings()
        if settings.is_prod or settings.aegis_env in ("staging", "dev"):
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains; preload"
            )

        # Referrer policy — don't leak URLs to third parties
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

        # Permissions policy — limit browser features (optional, tighten as needed)
        response.headers["Permissions-Policy"] = (
            "geolocation=(), microphone=(), camera=()"
        )

        return response
