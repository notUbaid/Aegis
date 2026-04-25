"""Incident Classifier Agent.

Fuses one or more perceptual signals (vision, audio, sensor, phone) into a
single ``IncidentClassification`` with severity, category, confidence,
rationale, and cascade predictions.

Phase 1 runs on Gemini 2.5 Flash. Falls back to a deterministic rule-based
classifier if Gemini is unavailable so the pipeline remains green in CI.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from aegis_shared.errors import AegisError
from aegis_shared.gemini import GeminiClient, get_gemini_client
from aegis_shared.logger import get_logger
from aegis_shared.prompts import load_prompt
from aegis_shared.schemas import (
    CascadePrediction,
    IncidentCategory,
    IncidentClassification,
    PerceptualSignal,
    Severity,
)
from pydantic import BaseModel

log = get_logger(__name__)


def _system_prompt() -> tuple[str, str]:
    """Load the classifier prompt text + hash for audit trail."""
    prompt = load_prompt("classifier")
    return prompt.text, prompt.hash


@dataclass(frozen=True)
class ClassifierInput:
    signals: Sequence[PerceptualSignal]
    venue_id: str
    zone_id: str

    def describe(self) -> str:
        lines = [f"Venue: {self.venue_id}", f"Zone: {self.zone_id}", "Signals:"]
        for s in self.signals:
            rec = {
                "signal_id": s.signal_id,
                "modality": s.modality.value,
                "category_hint": s.category_hint.value if s.category_hint else None,
                "confidence": round(s.confidence, 3),
                "detected_at": s.detected_at.isoformat(),
                "vision": s.vision.model_dump(mode="json") if s.vision else None,
                "raw": s.raw,
            }
            lines.append(f"- {rec}")
        return "\n".join(lines)


class ClassifierOutput(BaseModel):
    """Wire shape enforced on the Gemini response."""

    category: IncidentCategory
    sub_type: str | None = None
    severity: Severity
    confidence: float
    rationale: str
    cascade_predictions: list[CascadePrediction] = []


class ClassifierAgent:
    """Async classifier with deterministic fallback."""

    model_alias = "flash"
    version = "classifier-v0.1"

    def __init__(self, client: GeminiClient | None = None) -> None:
        self._client = client or get_gemini_client()

    async def run(self, inp: ClassifierInput) -> IncidentClassification:
        prompt = f"Classify the following signals into one incident.\n\n{inp.describe()}"
        try:
            system_text, prompt_hash = _system_prompt()
            parsed = await self._client.generate_structured(
                prompt,
                schema=ClassifierOutput,
                model=self.model_alias,
                system_instruction=system_text,
                temperature=0.1,
            )
            log.info(
                "classifier_prompt",
                prompt_hash=prompt_hash,
                version=self.version,
            )
        except AegisError as exc:
            log.warning(
                "classifier_fallback_to_rules",
                venue_id=inp.venue_id,
                zone_id=inp.zone_id,
                error=str(exc),
            )
            return _rule_based(inp)

        return IncidentClassification(
            category=parsed.category,
            sub_type=parsed.sub_type,
            severity=parsed.severity,
            confidence=max(0.0, min(0.95, parsed.confidence)),
            rationale=parsed.rationale,
            cascade_predictions=parsed.cascade_predictions,
        )


# ---------- Deterministic fallback (used in CI and when Gemini is unavailable) ----------


def _rule_based(inp: ClassifierInput) -> IncidentClassification:
    """Mirror of the old Phase 1 rule-based path."""
    best = max(inp.signals, key=lambda s: s.confidence, default=None)
    if best is None or best.category_hint is None:
        return IncidentClassification(
            category=IncidentCategory.OTHER,
            severity=Severity.S4_NUISANCE,
            confidence=0.05,
            rationale="No signal data available.",
        )
    hint = best.category_hint
    conf = best.confidence
    # Best-effort sub_type from upstream Vision evidence; fall back to a
    # generic label rather than always claiming KITCHEN_FIRE.
    fire_sub = best.vision.sub_type if best.vision and best.vision.sub_type else "GENERAL_FIRE"
    if hint == IncidentCategory.FIRE and conf >= 0.8:
        sev = Severity.S2_URGENT
        rationale = "High-confidence fire signal with cascade risk."
        sub = fire_sub
    elif hint == IncidentCategory.FIRE and conf >= 0.5:
        sev = Severity.S3_MONITOR
        rationale = "Moderate-confidence fire signal; monitoring."
        sub = fire_sub
    elif hint == IncidentCategory.MEDICAL and conf >= 0.7:
        sev = Severity.S1_CRITICAL
        rationale = "Medical distress detected with high confidence."
        sub = "MEDICAL_DISTRESS"
    elif hint == IncidentCategory.STAMPEDE and conf >= 0.6:
        sev = Severity.S2_URGENT
        rationale = "Crowd surge signals detected."
        sub = "CROWD_SURGE"
    else:
        sev = Severity.S4_NUISANCE
        rationale = "Low-signal observation; no action warranted."
        sub = None
    return IncidentClassification(
        category=hint,
        sub_type=sub,
        severity=sev,
        confidence=conf,
        rationale=rationale,
        cascade_predictions=[],
    )
