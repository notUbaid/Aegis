# Aegis Demo Guide

## Who it for
Venue duty managers + on-shift responders at large gatherings (hotels, stadiums, ballrooms). Operators run dashboard in control room. Staff carry mobile app on shift.

## Boot
```bash
make emulators       # Firestore + Pub/Sub
make dev             # ingest:8001 vision:8002 orch:8003 dispatch:8004
npm run dev:dashboard # :3002
npm run dev:staff     # :3001
```

## Demo flow (4 min)

### 1 · Control Room (`localhost:3002`)
- **TopBar pills (ING/VIS/ORC/DIS)** — point: 4 backend services live, ports tooltip
- **Run drill** (top right) — fires synthetic frame Ingest→Vision→Orchestrator. 3-step modal lights green
- **Critical hero (red panel)** — S1 incident auto-promoted. Cascade chips show 2/5min risk %
- Click **View incident** on hero → detail page

### 2 · Incident Detail
- **Status ladder** — DETECTED→CLOSED progression w/ pulse on current
- **Quick actions row** — Acknowledge / Escalate / Mark resolved / Dismiss. Each writes Firestore + audit event
- **Evidence frame** w/ AI rationale block
- **Cascade predictions** — bars + %
- **Audit timeline** — events + dispatch milestones merged, hash-chain pill
- **Page another responder** (right rail, expand details) — POSTs `/v1/dispatches`
- **Dispatch ladder** buttons (Ack/En route/Arrived/Hand off) — real `/v1/dispatches/{id}/{action}`
- **Operator note** — Firestore audit-event write
- **Nearby services** — call 108/101/100 (toast)

### 3 · Camera Mosaic
- TopBar **Cameras** toggle → slide-in panel right
- 7 zone cameras, red dot pulse on incident zones, click → open incident

### 4 · Tabs (TopBar)
- **History** — log + closed/dismissed counts
- **Setup** — venue profile, zones, roster, nearby services
- **Analytics** — category bars, severity mix, pilot scorecard (p50 43s, SLA 96%)

### 5 · Staff App (`localhost:3001`)
- **CriticalAlert** hero — Acknowledge / Decline / Details (real dispatch API)
- Bottom nav: **Alerts / History / Me**
- Click open dispatch → progression buttons (En route → Arrived → Hand off)
- **Profile** tab — On-shift toggle, skill chips, languages

## Key talking points
- All 4 backend services visible top bar — health-pinged 10s
- Every action writes audit event to Firestore subcollection
- Dispatch state machine enforced server-side (PAGED→ACK→ENROUTE→ARRIVED→HANDED_OFF + DECLINED)
- Drill mode flag tags audit events, gates authority webhooks
- Dispatch latency SLA target: 60s. p50 measured: 43s

## Tech
Next.js 14 (apps/dashboard, apps/staff) · FastAPI (services/) · Firestore live · Pub/Sub event bus · Gemini Vision · IBM Plex Sans/Mono · Glassmorphism dark UI
