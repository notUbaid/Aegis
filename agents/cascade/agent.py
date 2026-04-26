"""Cascade Predictor Agent.

Given a current classification and some venue graph context, forecasts the
30s / 90s / 300s trajectory of the incident and produces recommended pre-emptive
actions. Novel contribution per blueprint §59.

Runs on Gemini 2.5 Pro when available; falls back to a closed-form heuristic
that keeps the demo deterministic in CI.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from aegis_shared.errors import AegisError
from aegis_shared.gemini import GeminiClient, get_gemini_client
from aegis_shared.logger import get_logger
from aegis_shared.prompts import load_prompt
from aegis_shared.schemas import (
    CascadePrediction,
    IncidentCategory,
    IncidentClassification,
    Severity,
)
from pydantic import BaseModel, Field

log = get_logger(__name__)


def _system_prompt() -> tuple[str, str]:
    prompt = load_prompt("cascade_predictor")
    return prompt.text, prompt.hash


@dataclass(frozen=True)
class CascadeInput:
    classification: IncidentClassification
    venue_id: str
    zone_id: str
    venue_context: dict[str, Any]

    def describe(self) -> str:
        return (
            f"Current classification:\n"
            f"{self.classification.model_dump(mode='json')}\n\n"
            f"Venue: {self.venue_id} Zone: {self.zone_id}\n"
            f"Context:\n{self.venue_context}"
        )


class RecommendedAction(BaseModel):
    action: str
    trigger_horizon_seconds: int
    rationale: str = ""


class CascadeOutput(BaseModel):
    predictions: list[CascadePrediction] = Field(default_factory=list)
    recommended_preemptive_actions: list[RecommendedAction] = Field(default_factory=list)
    rationale: str = ""


class CascadeAgent:
    model_alias = "pro"
    version = "cascade-v0.1"

    def __init__(self, client: GeminiClient | None = None) -> None:
        self._client = client or get_gemini_client()

    async def run(self, inp: CascadeInput) -> CascadeOutput:
        prompt = (
            "Predict the cascade trajectory for the following incident and "
            "recommend pre-emptive actions.\n\n"
            f"{inp.describe()}"
        )
        try:
            system_text, prompt_hash = _system_prompt()
            result = await self._client.generate_structured(
                prompt,
                schema=CascadeOutput,
                model=self.model_alias,
                system_instruction=system_text,
                temperature=0.2,
            )
            log.info(
                "cascade_prompt",
                prompt_hash=prompt_hash,
                version=self.version,
            )
            return result
        except AegisError as exc:
            log.warning(
                "cascade_fallback_to_rules",
                venue_id=inp.venue_id,
                error=str(exc),
            )
            return _heuristic_cascade(inp)


def _heuristic_cascade(inp: CascadeInput) -> CascadeOutput:
    """Closed-form fallback that at least produces a plausible trajectory."""
    c = inp.classification
    base = c.confidence
    preds: list[CascadePrediction] = []
    actions: list[RecommendedAction] = []

    if c.category == IncidentCategory.FIRE:
        preds = [
            CascadePrediction(
                horizon_seconds=30, outcome="contained", probability=min(0.75, 1 - base)
            ),
            CascadePrediction(
                horizon_seconds=90, outcome="vertical_smoke_spread", probability=base * 0.35
            ),
            CascadePrediction(
                horizon_seconds=300, outcome="multi_floor_spread", probability=base * 0.15
            ),
        ]
        if c.severity in (Severity.S1_CRITICAL, Severity.S2_URGENT):
            actions.append(
                RecommendedAction(
                    action="stage_fire_service",
                    trigger_horizon_seconds=90,
                    rationale=(
                        "Cascade risk to vertical smoke spread warrants "
                        "staging external responders."
                    ),
                )
            )
            actions.append(
                RecommendedAction(
                    action="pre_alert_rooms_above",
                    trigger_horizon_seconds=60,
                    rationale="Occupants directly above should be pre-notified.",
                )
            )
    elif c.category == IncidentCategory.STAMPEDE:
        preds = [
            CascadePrediction(horizon_seconds=30, outcome="density_relaxes", probability=0.4),
            CascadePrediction(horizon_seconds=90, outcome="surge_at_exit", probability=base * 0.6),
        ]
        actions.append(
            RecommendedAction(
                action="open_secondary_exit",
                trigger_horizon_seconds=30,
                rationale="Relieve crowd flow before pressure at primary exit increases.",
            )
        )
    elif c.category == IncidentCategory.MEDICAL:
        preds = [
            CascadePrediction(
                horizon_seconds=30, outcome="patient_stable", probability=max(0.1, 1 - base)
            ),
            CascadePrediction(
                horizon_seconds=90, outcome="deterioration_possible", probability=base * 0.5
            ),
        ]
        actions.append(
            RecommendedAction(
                action="dispatch_bls_responder",
                trigger_horizon_seconds=30,
                rationale="Reduce time-to-care during the first golden minutes.",
            )
        )

    return CascadeOutput(
        predictions=preds,
        recommended_preemptive_actions=actions,
        rationale="Heuristic fallback (Gemini unavailable); deterministic shape for demo.",
    )
