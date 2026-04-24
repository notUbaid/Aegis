"""Vision service.

Consumes frames → Gemini Vision (multimodal) → emits ``PerceptualSignal``.

Endpoints:
    GET  /health                      liveness
    POST /v1/analyze                  synchronous analyze (for demo + staff triggering)
    POST /pubsub/raw-frames           Pub/Sub push subscriber (prod)

If the ``GOOGLE_API_KEY`` / Vertex AI credentials are unavailable OR Gemini
returns an error, the service falls back to a heuristic stub so the pipeline
stays green in CI and during emulator-only dev.
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from aegis_shared import get_settings, setup_logging
from aegis_shared.errors import DownstreamServiceError
from aegis_shared.gemini import get_gemini_client
from aegis_shared.logger import get_logger
from aegis_shared.prompts import load_prompt
from aegis_shared.pubsub import publish_json
from aegis_shared.schemas import (
    IncidentCategory,
    PerceptualSignal,
    SignalModality,
    VisionClassification,
    VisionEvidence,
)
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    setup_logging("vision")
    log = get_logger(__name__)
    settings = get_settings()
    log.info(
        "vision_service_started",
        project=settings.gcp_project_id,
        model=settings.gemini_flash_model,
        has_api_key=bool(settings.google_api_key),
    )
    yield
    log.info("vision_service_stopped")


app = FastAPI(
    title="Aegis Vision",
    version="0.1.0",
    description="Multimodal Gemini-backed frame classifier.",
    lifespan=lifespan,
)
log = get_logger(__name__)


class AnalyzeRequest(BaseModel):
    venue_id: str
    camera_id: str
    zone_id: str
    frame_base64: str = Field(description="JPEG bytes, base64-encoded")
    image_mime: str = Field(default="image/jpeg")
    publish: bool = Field(
        default=True,
        description="If true, publish the perceptual signal to Pub/Sub.",
    )


class AnalyzeResponse(BaseModel):
    signal: PerceptualSignal
    model: str
    wall_clock_ms: int
    used_gemini: bool
    prompt_hash: str


class PubSubMessage(BaseModel):
    data: str | None = None
    attributes: dict[str, str] | None = None
    message_id: str | None = Field(default=None, alias="messageId")


class PubSubEnvelope(BaseModel):
    message: PubSubMessage
    subscription: str | None = None


_HEURISTIC_FALLBACK = VisionClassification(
    category=IncidentCategory.OTHER,
    sub_type=None,
    confidence=0.05,
    evidence=VisionEvidence(),
    rationale="fallback: no Gemini available, heuristic OTHER",
)


async def _classify_with_gemini(
    frame_bytes: bytes,
    mime: str,
    venue_id: str,
    camera_id: str,
    zone_id: str,
) -> tuple[VisionClassification, str]:
    """Call Gemini 2.5 Flash with the vision classifier prompt.

    Returns ``(classification, prompt_hash)``. Raises ``DownstreamServiceError``
    on hard failure (the caller decides whether to fall back).
    """
    prompt = load_prompt("vision_classifier")
    user_prompt = (
        f"{prompt.text}\n\n"
        f"## Runtime context\n"
        f"- venue_id: {venue_id}\n"
        f"- camera_id: {camera_id}\n"
        f"- zone_id: {zone_id}\n"
        f"- captured_at: {datetime.now(UTC).isoformat()}\n"
    )
    client = get_gemini_client()
    classification = await client.analyze_image(
        user_prompt,
        frame_bytes,
        schema=VisionClassification,
        model="flash",
        image_mime=mime,
    )
    return classification, prompt.hash


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "vision"}


@app.post("/v1/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    """Analyze one frame synchronously.

    Real Gemini Vision call (falls back to a heuristic stub if unreachable so
    the full pipeline remains demoable without live credentials).
    """
    start = datetime.now(UTC)
    settings = get_settings()

    try:
        raw = base64.b64decode(req.frame_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="invalid base64") from exc

    if len(raw) == 0:
        raise HTTPException(status_code=400, detail="empty frame")

    used_gemini = False
    prompt_hash = "stub"
    try:
        classification, prompt_hash = await _classify_with_gemini(
            raw,
            req.image_mime,
            req.venue_id,
            req.camera_id,
            req.zone_id,
        )
        used_gemini = True
    except DownstreamServiceError as exc:
        log.warning(
            "vision_gemini_fallback",
            venue_id=req.venue_id,
            camera_id=req.camera_id,
            error=str(exc),
        )
        classification = _HEURISTIC_FALLBACK

    signal = PerceptualSignal(
        venue_id=req.venue_id,
        zone_id=req.zone_id,
        modality=SignalModality.VISION,
        category_hint=classification.category,
        confidence=classification.confidence,
        vision=classification,
        raw={
            "camera_id": req.camera_id,
            "frame_size_bytes": len(raw),
            "prompt_hash": prompt_hash,
            "used_gemini": used_gemini,
        },
    )

    if req.publish:
        publish_json(
            settings.pubsub_topic_perceptual,
            signal,
            ordering_key=f"{signal.venue_id}",
            attributes={
                "venue_id": signal.venue_id,
                "zone_id": signal.zone_id,
                "camera_id": req.camera_id,
                "modality": signal.modality.value,
            },
        )

    elapsed_ms = int((datetime.now(UTC) - start).total_seconds() * 1000)

    log.info(
        "vision_analyze_ok",
        signal_id=signal.signal_id,
        venue_id=req.venue_id,
        camera_id=req.camera_id,
        category=classification.category.value,
        confidence=classification.confidence,
        used_gemini=used_gemini,
        elapsed_ms=elapsed_ms,
    )

    return AnalyzeResponse(
        signal=signal,
        model=settings.gemini_flash_model,
        wall_clock_ms=elapsed_ms,
        used_gemini=used_gemini,
        prompt_hash=prompt_hash,
    )


@app.post("/pubsub/raw-frames")
async def pubsub_raw_frames(envelope: PubSubEnvelope) -> dict[str, str]:
    """Push endpoint for the raw-frames topic."""
    if not envelope.message.data:
        raise HTTPException(status_code=400, detail="empty message")
    try:
        raw = base64.b64decode(envelope.message.data).decode("utf-8")
        payload = json.loads(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="invalid payload") from exc

    attributes = envelope.message.attributes or {}

    try:
        request = AnalyzeRequest(
            venue_id=str(payload["venue_id"]),
            camera_id=str(payload["camera_id"]),
            zone_id=str(
                payload.get("zone_id") or attributes.get("zone_id") or payload["camera_id"]
            ),
            frame_base64=str(payload["bytes_base64"]),
            image_mime=str(payload.get("content_type") or "image/jpeg"),
            publish=True,
        )
    except KeyError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"missing field: {exc.args[0]}",
        ) from exc

    await analyze(request)
    return {"ack": "true"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8002, reload=True)  # noqa: S104
