"""Dispatcher Agent — responder selection.

Triage-constrained dispatcher per blueprint §60. Three-stage pipeline:

    1. Hard filter — drop responders who can't handle the incident
       (missing skills, off-shift, expired credential, distance > max ETA).
    2. Score + rank — ETA + skill fit + language match + workload.
    3. (Optional) Gemini re-rank of the top-3 with structured reasoning.

Phase 1 ships stages 1 and 2 with a small deterministic score function. Stage 3
is wired in but only invoked when Gemini is reachable; falls back cleanly
otherwise. The CSP/LP flavour from §60 is Phase 2.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

from aegis_shared.errors import AegisError
from aegis_shared.gemini import GeminiClient, get_gemini_client
from aegis_shared.logger import get_logger
from aegis_shared.prompts import load_prompt
from aegis_shared.schemas import (
    IncidentCategory,
    IncidentClassification,
    ResponderSkill,
    Severity,
)
from pydantic import BaseModel, Field

log = get_logger(__name__)


@dataclass
class ResponderRecord:
    responder_id: str
    display_name: str
    role: str
    skills: list[ResponderSkill]
    languages: list[str]
    on_shift: bool = True
    credential_valid: bool = True
    distance_m: float = 0.0
    workload: int = 0  # active dispatches on this responder right now
    fcm_tokens: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DispatcherInput:
    incident_id: str
    venue_id: str
    zone_id: str
    classification: IncidentClassification
    responders: Sequence[ResponderRecord]
    required_skills: Sequence[ResponderSkill] = ()
    language_preferences: Sequence[str] = ()
    max_eta_seconds: int = 300


class DispatchEntry(BaseModel):
    responder_id: str
    role: str
    score: float
    eta_seconds: int
    rationale: str = ""


class DispatcherOutput(BaseModel):
    incident_id: str
    dispatched: list[DispatchEntry] = Field(default_factory=list)
    backup_ladder: list[DispatchEntry] = Field(default_factory=list)
    rationale: str = ""
    used_gemini: bool = False


WALKING_SPEED_MPS = 1.35  # average indoor walking speed

SKILL_REQUIRED_BY_CATEGORY: dict[IncidentCategory, list[ResponderSkill]] = {
    IncidentCategory.FIRE: [ResponderSkill.FIRE_WARDEN],
    IncidentCategory.MEDICAL: [ResponderSkill.FIRST_AID, ResponderSkill.BLS],
    IncidentCategory.STAMPEDE: [ResponderSkill.EVACUATION, ResponderSkill.SECURITY],
    IncidentCategory.VIOLENCE: [ResponderSkill.SECURITY],
    IncidentCategory.SUSPICIOUS: [ResponderSkill.SECURITY],
    IncidentCategory.OTHER: [],
}


def _derive_required_skills(
    classification: IncidentClassification,
    override: Sequence[ResponderSkill],
) -> list[ResponderSkill]:
    if override:
        return list(override)
    return SKILL_REQUIRED_BY_CATEGORY.get(classification.category, [])


def _eta_seconds(r: ResponderRecord) -> int:
    return max(5, math.ceil(r.distance_m / WALKING_SPEED_MPS))


def _skill_score(r: ResponderRecord, required: Sequence[ResponderSkill]) -> float:
    if not required:
        return 1.0
    matched = sum(1 for s in required if s in r.skills)
    return matched / len(required)


def _lang_score(r: ResponderRecord, prefs: Sequence[str]) -> float:
    if not prefs:
        return 1.0
    return 1.0 if any(lang in r.languages for lang in prefs) else 0.3


def _composite_score(
    r: ResponderRecord,
    required_skills: Sequence[ResponderSkill],
    language_prefs: Sequence[str],
    max_eta: int,
) -> float:
    eta = min(_eta_seconds(r), max_eta)
    eta_score = 1 - (eta / max_eta)
    skill = _skill_score(r, required_skills)
    lang = _lang_score(r, language_prefs)
    workload_penalty = 1 / (1 + r.workload)
    return 0.5 * eta_score + 0.3 * skill + 0.1 * lang + 0.1 * workload_penalty


class _GeminiRerank(BaseModel):
    ordered_responder_ids: list[str]
    rationale: str


def _rerank_system_prompt() -> tuple[str, str]:
    prompt = load_prompt("dispatcher_rerank")
    return prompt.text, prompt.hash


class DispatcherAgent:
    version = "dispatcher-v0.1"

    def __init__(self, client: GeminiClient | None = None) -> None:
        self._client = client or get_gemini_client()

    async def run(self, inp: DispatcherInput) -> DispatcherOutput:
        required = _derive_required_skills(inp.classification, inp.required_skills)

        # 1. Hard filter and initial scoring
        pool = self._filter_and_score(inp, required)
        if not pool:
            return DispatcherOutput(
                incident_id=inp.incident_id,
                rationale="No eligible responders after filtering.",
            )

        # 2. Gemini re-ranking
        ordered_ids, rerank_rationale, used_gemini = await self._rerank_if_needed(
            inp, required, pool
        )

        # 3. Final selection
        dispatched, backup = self._select_responders(inp.classification.severity, pool, ordered_ids)

        rationale = rerank_rationale or (
            f"Ranked {len(pool)} eligible responders; dispatched "
            f"{len(dispatched)} primary and queued {len(backup)} backup."
        )

        return DispatcherOutput(
            incident_id=inp.incident_id,
            dispatched=dispatched,
            backup_ladder=backup,
            rationale=rationale,
            used_gemini=used_gemini,
        )

    def _filter_and_score(
        self, inp: DispatcherInput, required: list[ResponderSkill]
    ) -> list[tuple[ResponderRecord, float, int]]:
        """Applies hard filters and calculates initial composite scores."""
        pool: list[tuple[ResponderRecord, float, int]] = []
        for r in inp.responders:
            if not r.on_shift or not r.credential_valid:
                continue
            eta = _eta_seconds(r)
            if eta > inp.max_eta_seconds:
                continue
            if required and _skill_score(r, required) == 0:
                continue
            score = _composite_score(r, required, inp.language_preferences, inp.max_eta_seconds)
            pool.append((r, score, eta))

        pool.sort(key=lambda x: x[1], reverse=True)
        return pool

    async def _rerank_if_needed(
        self,
        inp: DispatcherInput,
        required: list[ResponderSkill],
        pool: list[tuple[ResponderRecord, float, int]],
    ) -> tuple[list[str], str, bool]:
        """Optionally invokes Gemini to re-rank the top candidates based on context."""
        top = pool[:3]
        ordered_ids = [r.responder_id for r, _, _ in top]

        if len(top) <= 1 or inp.classification.severity not in (
            Severity.S1_CRITICAL,
            Severity.S2_URGENT,
        ):
            return ordered_ids, "", False

        candidates_desc = "\n".join(
            f"- id={r.responder_id} name={r.display_name} role={r.role} "
            f"skills={[s.value for s in r.skills]} languages={r.languages} "
            f"eta_s={eta} workload={r.workload}"
            for r, _score, eta in top
        )
        prompt = (
            f"Incident: {inp.classification.model_dump(mode='json')}\n"
            f"Language preferences: {list(inp.language_preferences)}\n"
            f"Required skills: {[s.value for s in required]}\n"
            f"Candidates:\n{candidates_desc}"
        )

        try:
            system_text, prompt_hash = _rerank_system_prompt()
            rerank = await self._client.generate_structured(
                prompt,
                schema=_GeminiRerank,
                model="flash",
                system_instruction=system_text,
                temperature=0.1,
            )
            log.info(
                "dispatcher_rerank_prompt",
                prompt_hash=prompt_hash,
                version=self.version,
            )
            known = {r.responder_id for r, _, _ in top}
            filtered = [rid for rid in rerank.ordered_responder_ids if rid in known]
            return filtered or ordered_ids, rerank.rationale, True
        except AegisError as exc:
            log.warning("dispatcher_rerank_failed", error=str(exc))
            return ordered_ids, "", False

    def _select_responders(
        self,
        severity: Severity,
        pool: list[tuple[ResponderRecord, float, int]],
        ordered_ids: list[str],
    ) -> tuple[list[DispatchEntry], list[DispatchEntry]]:
        """Selects primary responders and fills the backup ladder."""
        dispatched: list[DispatchEntry] = []
        backup: list[DispatchEntry] = []

        primary_n = 2 if severity == Severity.S1_CRITICAL else 1
        by_id = {r.responder_id: (r, score, eta) for r, score, eta in pool}
        primary_ids = ordered_ids[:primary_n]

        for rid in primary_ids:
            r, score, eta = by_id[rid]
            dispatched.append(
                DispatchEntry(
                    responder_id=rid,
                    role=r.role,
                    score=round(score, 3),
                    eta_seconds=eta,
                    rationale=f"Top composite score for {r.display_name}.",
                )
            )

        used_ids = set(primary_ids)
        backup_candidates: list[tuple[ResponderRecord, float, int]] = []
        for rid in ordered_ids[primary_n:]:
            if rid not in used_ids:
                backup_candidates.append(by_id[rid])
                used_ids.add(rid)

        for r, score, eta in pool:
            if r.responder_id not in used_ids:
                backup_candidates.append((r, score, eta))
                used_ids.add(r.responder_id)

        for r, score, eta in backup_candidates[:2]:
            backup.append(
                DispatchEntry(
                    responder_id=r.responder_id,
                    role=r.role,
                    score=round(score, 3),
                    eta_seconds=eta,
                    rationale="Backup candidate.",
                )
            )

        return dispatched, backup
