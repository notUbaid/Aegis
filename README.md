<div align="center">

# Aegis

### *The coordination layer between CCTV, staff, and ambulances.*

**From first signal to dispatched responder — in under 60 seconds.**

[![Solution Challenge 2026](https://img.shields.io/badge/Google%20Solution%20Challenge-2026-4285F4?style=flat-square&logo=google)](https://developers.google.com/community/gdsc-solution-challenge)
[![Built on Google Cloud](https://img.shields.io/badge/Built%20on-Google%20Cloud-4285F4?style=flat-square&logo=googlecloud&logoColor=white)](https://cloud.google.com)
[![Gemini 2.5](https://img.shields.io/badge/Gemini-2.5%20Flash-886FBF?style=flat-square&logo=google)](https://ai.google.dev)
[![Vertex AI ADK](https://img.shields.io/badge/Vertex%20AI-Agent%20Kit-34A853?style=flat-square&logo=google)](https://cloud.google.com/vertex-ai)
[![Python 3.12](https://img.shields.io/badge/Python-3.12-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org)
[![Next.js 14](https://img.shields.io/badge/Next.js-14-000000?style=flat-square&logo=nextdotjs)](https://nextjs.org)
[![License Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=flat-square)](LICENSE)

**Team Better Call Coders** · Theme: *Rapid Crisis Response*

</div>

---

## The problem

> Every year, **over 2,000 Indians die** in venue incidents — hotel fires, wedding stampedes, religious-gathering crushes, conference medical emergencies — that were **survivable if responders had arrived three minutes earlier**.

Existing venue safety is four silos glued together: a wall of CCTV, a PA system, a PBX phonebook, and a paper log. A duty manager at 2 AM loses four minutes just figuring out *who to call in what order*. For cardiac arrest, anaphylaxis, or smoke inhalation, those are the minutes that decide.

## What Aegis does

Aegis is an **agentic AI platform** that turns any mass gathering — hotel, wedding, conference, religious site — into a **self-monitoring, self-coordinating emergency response system**.

| Stage | What happens | Time |
|---|---|---|
| Perception | Gemini 2.5 watches every camera, listens to audio, ingests IoT sensor streams | 0–1s |
| Classification | A multi-agent team on Vertex AI ADK classifies the incident type + severity | 1–3s |
| Triage & dispatch | The Dispatcher agent picks the nearest qualified responder and pages them via FCM | 3–10s |
| Coordination | Evacuation, Comms, and Authority-Reporter agents run in parallel | 10–60s |

> We optimise for one number: **Dispatch Latency (DL)** — time from first signal to responder en-route with correct brief. Industry baseline is **12–18 minutes**. Our target is **p95 ≤ 60 seconds**.

---

## System at a glance

```
          ┌────────────────────────────────────────────────────┐
          │  EDGE          CCTV · Audio · Phones · IoT sensors │
          └──────────────────────────┬─────────────────────────┘
                                     │ HTTPS / mTLS
                                     ▼
                         ┌──────────────────────┐
                         │   Ingest (Cloud Run) │
                         └──────────┬───────────┘
                                    │ Pub/Sub · raw-frames
                                    ▼
                         ┌──────────────────────┐
                         │  Vision · Gemini 2.5 │  ← structured JSON, bbox evidence
                         └──────────┬───────────┘
                                    │ Pub/Sub · perceptual-signals
                                    ▼
      ╔═════════════════════════════════════════════════════════╗
      ║       Orchestrator  ·  Vertex AI ADK multi-agent        ║
      ║                                                         ║
      ║   Classifier → Triage → Dispatcher → Evacuation → Comms ║
      ║        │         │          │            │         │    ║
      ║        └─── Cascade Predictor (what happens next?) ─┘    ║
      ╚════════════════════════════╤════════════════════════════╝
                                   │ Pub/Sub · dispatch-events
                                   ▼
                         ┌──────────────────────┐
                         │  Dispatch · FCM page │──► Responder phones
                         └──────────┬───────────┘
                                    │
                                    ▼
   ┌───────────────────────────────────────────────────────────┐
   │  Staff PWA   ·   Venue Dashboard   ·   BigQuery audit     │
   │  (Firebase App Hosting)            (tamper-evident chain) │
   └───────────────────────────────────────────────────────────┘
```

Every decision every agent makes is written to a **SHA-256 hash-chained BigQuery audit table** — insurers, regulators, and post-incident reviewers can verify nothing was altered.

---

## Features

- **Multi-modal perception** — CCTV frames, audio events, IoT sensors, crowdsourced phone sensors (opt-in) fused into one event stream.
- **Six specialised agents on Vertex AI ADK** — Classifier, Triage, Dispatcher, Cascade Predictor, Evacuation, Comms. Each owns one decision; the orchestrator arbitrates.
- **Cascade forecasting** — "a small kitchen fire now becomes a ballroom smoke event in 4 min" — drives pre-emptive evacuation.
- **Consent-gated surveillance** — guest cameras require opt-in; faces and IDs redacted via Cloud DLP before storage.
- **Human-in-the-loop safety envelope** — any Severity-1 dispatch is held for 2s for staff override. The system is an assistant, not an autocrat.
- **Tamper-evident audit chain** — every action → BigQuery row with `prev_hash + row_hash` over canonical JSON. Verifiable offline.
- **Works offline-degraded** — if Gemini rate-limits or Vertex is slow, a heuristic fallback keeps the dispatch path alive. `used_gemini: false` is visible in the trace.
- **Built for India first** — Hindi-first staff UI, multi-lingual PA announcements (Translate + TTS), `asia-south1` region for sub-40ms round trips.

---

## Google Cloud services used — and why each one

| Service | What Aegis uses it for | Why it was the right call |
|---|---|---|
| **Gemini 2.5 Flash** (Developer API + Vertex) | Multimodal vision classification on every frame; structured-JSON agent tool-calls | Native vision, structured-output mode, the lowest $/frame of any model that hits our accuracy bar |
| **Vertex AI Agent Development Kit (ADK)** | Orchestrator + 6 specialist agents | First-class multi-agent orchestration with Google-issued creds, built-in tracing, no third-party framework to babysit |
| **Cloud Run** (`asia-south1`) | Hosts the 4 Python services (Ingest, Vision, Orchestrator, Dispatch) | Per-request billing, auto-scale to zero, CPU-always for hot paths, tight Pub/Sub + IAM integration |
| **Firebase App Hosting** | Next.js Staff PWA + Venue Dashboard (SSR) | Runs Next.js on managed Cloud Run in the same project — zero cross-cloud hops to Firestore/Auth/FCM, per-commit preview channels |
| **Firestore** (Native, `asia-south1`) | Live incident state, responder roster, venue/zone/camera model | Real-time listeners push updates to staff phones the instant the orchestrator writes; offline-capable SDK covers flaky Indian networks |
| **Firebase Authentication** | Staff + responder phone-OTP login, dashboard email/password | Integrated custom claims for venue membership + role (→ Firestore rules enforce RBAC) |
| **Firebase Cloud Messaging (FCM)** | Android high-priority responder pages with sound + vibration | High-priority pass-through wakes a sleeping phone; content-available APNS for iOS responders |
| **Firebase App Check** | Anti-abuse for ingest/web surfaces | Keeps random HTTP clients off the ingest endpoint without heavy auth on every device |
| **Cloud Pub/Sub** | Event backbone — 5 topics (`raw-frames`, `perceptual-signals`, `incident-events`, `dispatch-events`, `sensor-events`) + DLQs | Ordering keys (`venue_id:camera_id`) keep per-camera streams serial while scaling globally; push subscriptions let Cloud Run scale per event |
| **BigQuery** (`aegis_audit.events`) | Immutable append-only audit trail with SHA-256 hash chain | Streaming insert, columnar scan for regulator queries, cheap at scale; row-level hash chain proves no tampering |
| **Cloud Storage** | Raw frame + redacted evidence frame + audio chunk archive | 30-day lifecycle rule, signed URLs for authority handoff |
| **Cloud DLP** | Redacts faces, licence plates, and IDs from evidence frames before storage | Privacy-by-default; mandatory for guest-facing surveillance under Indian DPDP |
| **Secret Manager** | SendGrid / MSG91 / webhook signing keys / internal service secret | Versioned, IAM-scoped, rotatable — no secrets on disk |
| **Cloud Build + Artifact Registry** | Docker builds for all 4 services, registry in `asia-south1` | Build context aware of sibling `aegis-agents` package; matches region of Cloud Run |
| **Cloud Translate + Text-to-Speech** | Multi-lingual PA announcements (Hindi, English, Gujarati, Tamil, Bengali …) | Mass-gathering guests rarely share a language; TTS voices localised per region |
| **Speech-to-Text** | Audio event transcription for the audio-pipeline agent (Phase 2) | Decodes PA calls for trauma keywords; complements raw audio-event detection |
| **Google Maps Platform** (Maps JS, Places, Routes, Geocoding) | Staff indoor+outdoor map, ambulance routing, zone rendering | Routes API gives us live traffic ETA for off-site responders; Places API resolves nearby hospitals for triage |
| **Cloud Functions** (Firebase) | Custom-claims syncer, FCM token cleanup, scheduled rollups | One-off event-driven glue where a whole Cloud Run service would be overkill |
| **Cloud Logging + Monitoring** | Structured JSON logs, latency SLOs, PagerDuty alerts on `used_gemini:false` spikes | Structlog writes straight into Cloud Logging field names — zero adapter code |
| **Identity & IAM** | Per-service service accounts with least-privilege bindings | Workload Identity in prod; key files gated to `.secrets/` in dev |

Phase 2 additions already wired but not shipped: **MedGemma** (medical triage), **Vertex AI Evaluation** (prompt regression), **Cloud KMS** (row-hash signing), **Cloud Tasks** (escalation ladder).

---

## Tech stack

**Backend** · Python 3.12 · FastAPI · Pydantic v2 · structlog · uv · Pub/Sub async client · Firestore async client · Vertex AI ADK · Google Gen AI SDK
**Frontend** · Next.js 14 (App Router, Server Components) · TypeScript · Tailwind · shadcn/ui · Firebase Web SDK · Google Maps JS
**Mobile** · Flutter (Responder app, Phase 2) · Guest PWA (Next.js)
**Infra** · Cloud Run · Firebase App Hosting · Firestore · Pub/Sub · BigQuery · Terraform · Cloud Build
**Tooling** · Ruff · mypy (strict) · pytest · Playwright · k6 · pre-commit · GitHub Actions

---

## Quickstart

> Full setup is in [`SETUP.md`](./SETUP.md) · full deploy is in [`DEPLOY.md`](./DEPLOY.md). This section is the 60-second sprint.

### 1. Run locally

```powershell
# One-time
make setup                    # uv pip install -e on all services
Copy-Item .env.example .env   # fill in GOOGLE_API_KEY, GCP_PROJECT_ID, …

# Every day
make emulators                # Firestore :8080 + Pub/Sub :8085 in Docker
.\scripts\dev.ps1             # spins up Ingest / Vision / Orchestrator / Dispatch
```

Each service exposes Swagger at `/docs`:

| Service | URL |
|---|---|
| Ingest | http://localhost:8001/docs |
| Vision | http://localhost:8002/docs |
| Orchestrator | http://localhost:8003/docs |
| Dispatch | http://localhost:8004/docs |

### 2. Verify — one command, five checks

```powershell
.\scripts\smoke.ps1
```

```
== 1/5  Health checks ==           ✓  all 4 services 200 OK
== 2/5  Frame ingest ==            ✓  raw-frames publish
== 3/5  Vision classify ==         ✓  Gemini returned FIRE sub_type=kitchen
== 4/5  Orchestrator handle ==     ✓  classified S2 · dispatched
== 5/5  Dispatch state machine ==  ✓  ack → enroute → arrived
== Done ==  All systems nominal.
```

### 3. Run the apps

```powershell
cd apps/staff     && npm install && npm run dev    # → http://localhost:3000
cd apps/dashboard && npm install && npm run dev    # → http://localhost:3001
```

### 4. Ship to production

```powershell
cd terraform && terraform apply      # Pub/Sub, BigQuery, Storage, IAM, Artifact Registry
.\scripts\deploy.ps1                 # Build + deploy 4 Cloud Run services
.\scripts\deploy_firebase.ps1        # Firestore rules + indexes + Cloud Functions
firebase deploy --only apphosting    # Staff PWA + Venue Dashboard
```

---

## Demo walkthrough — 90 seconds

Open the **Staff PWA** (`https://aegis-staff--<project>.hosted.app`) and log in as a duty manager.

1. **Tap `/drill` → Trigger drill.** A pre-recorded CCTV frame of a kitchen fire is sent to Ingest.
2. **Vision screen lights up** within ~1.5s — Gemini 2.5 returns `FIRE / kitchen`, confidence 0.92, with a bounding box around the flame. The call is traceable: `used_gemini: true`, `prompt_hash: a3b1…`.
3. **Orchestrator** runs in parallel:
   - Classifier confirms `S2 · FIRE`
   - Triage estimates 0 injuries (no people in frame)
   - Cascade Predictor: *"Ballroom smoke event probable in 3m 40s — ventilation shared"*
   - Dispatcher re-ranks the 6 on-duty responders by distance + skill + current workload
4. **The senior engineer's phone buzzes** — FCM high-priority page with a 1-tap `/dispatch/ack` deep link.
5. **Home screen** shows the incident with a live status pill (`DETECTED → CLASSIFIED → DISPATCHED → ACKNOWLEDGED → EN_ROUTE → ARRIVED`) driven by Firestore listeners. No polling.
6. **The Audit reveal.** Switch to a BigQuery tab:

   ```sql
   SELECT event_time, action, actor_id, incident_id, row_hash, prev_hash
   FROM aegis_audit.events
   ORDER BY event_time DESC LIMIT 10
   ```

   Six rows — `incident.detected → .classified → .cascade_predicted → .dispatched → dispatch.paged → dispatch.acknowledged` — every `row_hash` links to the previous `prev_hash`. Change any cell and the chain breaks.

**Backup path for demo day:** if Gemini rate-limits mid-pitch, the heuristic fallback keeps the pipeline green; `used_gemini: false` shows up in the trace but the staff UI never blinks. The entire stack also runs on a laptop via `make emulators + make dev` if the hackathon Wi-Fi gives up.

---

## Repo map

```
/services           Python microservices (FastAPI on Cloud Run)
  /shared             config, logger, Gemini client, Firestore, Pub/Sub, audit chain
  /ingest             HTTPS ingest for frames / audio / sensor events
  /vision             Gemini 2.5 multimodal analyzer
  /orchestrator       Vertex AI ADK multi-agent brain
  /dispatch           Responder paging + escalation ladder + state machine
/agents             ADK agent definitions (Classifier, Triage, Dispatcher, …)
/apps               Client apps
  /staff              Next.js PWA for duty managers (Firebase App Hosting)
  /dashboard          Next.js venue-management dashboard
  /responder          Flutter responder app (Phase 2)
  /guest-pwa          Opt-in guest sensor-fusion PWA (Phase 2)
  /authority          Civic-authority console (Phase 2)
/packages           Shared TS packages (ui-web, schemas)
/firebase           Firestore rules, composite indexes, Cloud Functions
/pubsub-schemas     JSON Schemas for all 5 event topics
/prompts            Versioned, hash-audited agent prompts (.md)
/terraform          IaC for Pub/Sub, BigQuery, Storage, IAM, Artifact Registry
/scripts            dev.ps1, deploy.ps1, smoke.ps1, pack-ui.ps1, seed_venue.py
/docs               Architecture, ADRs, user research
/tests              Playwright (e2e) + k6 (load)
```

---

## The non-negotiables

1. **One metric rules.** Dispatch Latency ≤ 60s p95. Every design tradeoff breaks toward this.
2. **Calm tone, everywhere.** Aegis never uses exclamation points, never celebrates, never uses emojis in operator UIs — because Aegis is the product in the room when someone has just died. Resolved incidents are timestamped, not cheered.
3. **Human-in-the-loop safety envelope.** The system assists; humans decide. Every S1 dispatch is override-able for 2 seconds before it fires.
4. **Consent before surveillance.** Guest sensors are opt-in. Faces are DLP-redacted before storage. Private zones are off by default.
5. **Every action is auditable.** No silent writes. If it's not in `aegis_audit.events`, it didn't happen.

---

## Success metric

**Dispatch Latency (DL)** — from first perceptual signal to responder en-route with correct brief.

```
Industry baseline (Indian hotel incidents, 2018–2024 case studies)   12–18 min
Aegis target (p95, Severity-1)                                     ≤     60 s
Aegis Phase-1 measured (drill mode, asia-south1)                       22–31 s
```

---

## Contributing

1. Branch off `main` as `feat/<area>/<short-desc>`
2. `make lint test` (ruff + mypy + pytest + eslint) must be green
3. Open a PR → CI must pass → 1 review → merge
4. No direct commits to `main`

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the long form.

---

## SDG alignment

**SDG 3** Good Health & Well-Being · **SDG 11** Sustainable Cities & Communities · **SDG 16** Peace, Justice & Strong Institutions.
Detailed target-level mapping in the [Master Build Blueprint](./AEGIS_Master_Build_Blueprint.md) §4.

## Team

**Better Call Coders** · Google Solution Challenge 2026 · Open Innovation / Rapid Crisis Response track.

## 👨‍💻 Contributors

<p align="center">
  <table>
    <tr>
      <td align="center" width="50%">
        <div>
          <img src="https://avatars.githubusercontent.com/Sam-bot-dev?s=120" width="120px;" height="120px;" alt="Bhavesh"/>
        </div>
        <div><strong>🧩 Head Teammate</strong></div>
        <div><strong>Bhavesh</strong></div>
        <a href="https://github.com/Sam-bot-dev">🌐 GitHub</a>
      </td>
      <td align="center" width="50%">
        <div>
          <img src="https://avatars.githubusercontent.com/notUbaid?s=120" width="120px;" height="120px;" alt="Ubaid khan"/>
        </div>
        <div><strong>⭐ Team Leader</strong></div>
        <div><strong>Ubaid khan</strong></div>
        <a href="https://github.com/notUbaid">🌐 GitHub</a>
      </td>
    </tr>
  </table>
</p>

## License

Platform code is [Apache 2.0](./LICENSE). Agent prompts and fine-tuning datasets are proprietary (`/prompts` is versioned and hash-audited but not openly licensed).

---

<div align="center">

*Every second is a life.*

</div>
