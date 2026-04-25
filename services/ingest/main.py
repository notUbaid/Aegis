"""Ingest service.

Exposes HTTPS endpoints for the edge gateway (or demo clients) to push:
    - camera frames  → POST /v1/frames
    - audio chunks   → POST /v1/audio
    - sensor events  → POST /v1/sensors

Each validated request is:
    1. Stored to Cloud Storage (raw + DLP-redacted variant — redaction in Vision svc)
    2. Published to the corresponding Pub/Sub topic

No heavy processing happens here. This is the thin, high-availability edge.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from aegis_shared import get_settings, setup_logging
from aegis_shared.errors import AegisError
from aegis_shared.logger import get_logger
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from routers import frames, health, sensors


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    setup_logging("ingest")
    log = get_logger(__name__)
    settings = get_settings()
    log.info(
        "ingest_service_started",
        env=settings.aegis_env,
        project=settings.gcp_project_id,
        region=settings.gcp_region,
    )
    yield
    log.info("ingest_service_stopped")


app = FastAPI(
    title="Aegis Ingest",
    version="0.1.0",
    description="Edge ingest for frames, audio, and sensor events.",
    lifespan=lifespan,
)

# 1. CORS middleware (must be early)
# We allow the specific dashboard origin explicitly alongside the wildcard
# to handle some browser edge cases with Cloud Run / App Hosting.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
)


@app.exception_handler(AegisError)
async def aegis_exception_handler(request: Request, exc: AegisError) -> JSONResponse:
    log = get_logger(__name__)
    log.error("aegis_error", path=request.url.path, category=exc.audit_category, detail=str(exc))
    return JSONResponse(
        status_code=exc.http_status,
        content={"detail": str(exc), "category": exc.audit_category},
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
        },
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    log = get_logger(__name__)
    from fastapi import HTTPException as FastAPIHTTPException
    from fastapi.exceptions import RequestValidationError

    status_code = 500
    detail: Any = "Internal Server Error"

    if isinstance(exc, FastAPIHTTPException):
        status_code = exc.status_code
        detail = exc.detail
    elif isinstance(exc, RequestValidationError):
        status_code = 422
        detail = exc.errors()
    else:
        log.exception("unhandled_exception", path=request.url.path)

    return JSONResponse(
        status_code=status_code,
        content={"detail": detail},
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
        },
    )


app.include_router(health.router)
app.include_router(frames.router, prefix="/v1")
app.include_router(sensors.router, prefix="/v1")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)  # noqa: S104
