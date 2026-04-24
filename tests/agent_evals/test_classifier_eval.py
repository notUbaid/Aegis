"""Agent eval harness — blueprint §82.

Runs the Classifier + Dispatcher agents over a canonical scenario library and
asserts each scenario's expected category / severity / dispatch decision. Uses
the deterministic fallback path so the harness works in CI without Gemini
credentials. When Gemini is live, point the harness at a golden file that
records each Gemini output — the test here only gates on the rule-based
contract, so that passing Gemini-based evals are an addition, not a
replacement.

To run:

    pytest tests/agent_evals/ -v
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from aegis_shared.errors import DownstreamServiceError
from aegis_shared.schemas import (
    IncidentCategory,
    PerceptualSignal,
    ResponderSkill,
    Severity,
    SignalModality,
    VisionClassification,
    VisionEvidence,
)

from agents.classifier.agent import (
    ClassifierAgent,
    ClassifierInput,
    _rule_based,
)
from agents.dispatcher.agent import (
    DispatcherAgent,
    DispatcherInput,
    ResponderRecord,
)

SCENARIOS = json.loads(
    (Path(__file__).parent / "scenarios.json").read_text(encoding="utf-8"),
)

SEVERITY_RANK = {
    Severity.S1_CRITICAL: 1,
    Severity.S2_URGENT: 2,
    Severity.S3_MONITOR: 3,
    Severity.S4_NUISANCE: 4,
}


def _signal_from(payload: dict) -> PerceptualSignal:
    vision = None
    if payload.get("vision"):
        vision = VisionClassification(
            category=IncidentCategory(payload.get("category_hint", "OTHER")),
            sub_type=None,
            confidence=payload.get("confidence", 0.0),
            evidence=VisionEvidence(**payload["vision"]),
            rationale="eval scenario",
        )
    return PerceptualSignal(
        venue_id="eval-venue",
        zone_id="eval-zone",
        modality=SignalModality(payload["modality"]),
        category_hint=IncidentCategory(payload["category_hint"]),
        confidence=float(payload["confidence"]),
        vision=vision,
    )


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s["id"])
def test_classifier_rule_based_meets_expected(scenario: dict) -> None:
    signals = [_signal_from(p) for p in scenario["signals"]]
    inp = ClassifierInput(
        signals=signals,
        venue_id="eval-venue",
        zone_id="eval-zone",
    )
    result = _rule_based(inp)

    expected = scenario["expected"]
    # fmt: off
    assert result.category.value == expected["category"], (
        f"{scenario['id']}: expected {expected['category']} "
        f"got {result.category.value}"
    )

    expected_min = Severity(expected["severity_min"])
    assert SEVERITY_RANK[result.severity] <= SEVERITY_RANK[expected_min], (
        f"{scenario['id']}: expected severity ≤ {expected_min.value} "
        f"got {result.severity.value}"
    )
    # fmt: on


@pytest.mark.asyncio
async def test_classifier_agent_falls_back_without_gemini(monkeypatch) -> None:
    """ClassifierAgent with a mocked Gemini error must yield the rule-based output."""

    class _StubClient:
        async def generate_structured(self, *a, **kw):
            raise DownstreamServiceError("no gemini in eval")

    agent = ClassifierAgent(client=_StubClient())  # type: ignore[arg-type]
    scenario = next(s for s in SCENARIOS if s["id"] == "kitchen_fire_high_conf")
    signals = [_signal_from(p) for p in scenario["signals"]]
    out = await agent.run(
        ClassifierInput(signals=signals, venue_id="v", zone_id="z"),
    )
    assert out.category == IncidentCategory.FIRE
    assert SEVERITY_RANK[out.severity] <= SEVERITY_RANK[Severity.S2_URGENT]


@pytest.mark.asyncio
async def test_dispatcher_filters_by_skill_and_eta() -> None:
    """Verify hard-filter pipeline selects the qualified responder."""
    agent = DispatcherAgent(client=None)  # type: ignore[arg-type]

    responders = [
        ResponderRecord(
            responder_id="A",
            display_name="Too far",
            role="Fire Warden",
            skills=[ResponderSkill.FIRE_WARDEN],
            languages=["en"],
            distance_m=9999,
        ),
        ResponderRecord(
            responder_id="B",
            display_name="Correct",
            role="Fire Warden",
            skills=[ResponderSkill.FIRE_WARDEN, ResponderSkill.EVACUATION],
            languages=["hi", "en"],
            distance_m=20,
        ),
        ResponderRecord(
            responder_id="C",
            display_name="Wrong skill",
            role="Receptionist",
            skills=[ResponderSkill.FIRST_AID],
            languages=["en"],
            distance_m=15,
        ),
    ]

    from aegis_shared.schemas import IncidentClassification

    classification = IncidentClassification(
        category=IncidentCategory.FIRE,
        severity=Severity.S2_URGENT,
        confidence=0.9,
        rationale="test",
    )
    out = await agent.run(
        DispatcherInput(
            incident_id="INC-eval",
            venue_id="v",
            zone_id="z",
            classification=classification,
            responders=responders,
            language_preferences=["hi"],
        )
    )
    assert len(out.dispatched) == 1
    assert out.dispatched[0].responder_id == "B"
