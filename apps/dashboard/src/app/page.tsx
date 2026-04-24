"use client";

import * as React from "react";
import Link from "next/link";
import {
  getDb,
  IncidentCard,
  SeverityBadge,
  SEVERITY_COLOR,
  type Dispatch,
  type Incident,
  type Severity,
} from "@aegis/ui-web";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
  type QueryConstraint,
} from "firebase/firestore";

const DEFAULT_VENUE_ID =
  process.env.NEXT_PUBLIC_DEMO_VENUE_ID || "taj-ahmedabad";

type DashboardTab =
  | "live"
  | "history"
  | "setup"
  | "compliance"
  | "analytics"
  | "billing";

interface ZonePulseCardData {
  incidents: number;
  severity: Severity;
  status: string;
  summary: string;
  updatedAt: unknown;
  zoneId: string;
}

interface CameraTileData {
  headline: string;
  highlight: boolean;
  incidentId?: string;
  severity: Severity;
  status: string;
  summary: string;
  timestamp: unknown;
  zoneId: string;
}

interface ResponderCardData {
  dispatchId: string;
  incidentId: string;
  notes: string;
  responderId: string;
  role: string;
  status: Dispatch["status"];
  timestamp: unknown;
  zoneId: string;
}

const NAV_ITEMS: Array<{
  description: string;
  id: DashboardTab;
  label: string;
  phase: string;
}> = [
  {
    id: "live",
    label: "Live",
    phase: "P0",
    description: "Incident feed, camera mosaic, responder positions",
  },
  {
    id: "history",
    label: "History",
    phase: "P1",
    description: "Recent incidents, closure log, drill evidence",
  },
  {
    id: "setup",
    label: "Setup",
    phase: "P1",
    description: "Venue config, zones, cameras, responder roster",
  },
  {
    id: "compliance",
    label: "Compliance",
    phase: "P2",
    description: "Audit integrity, Sendai reports, authority packets",
  },
  {
    id: "analytics",
    label: "Analytics",
    phase: "P2",
    description: "Dispatch latency, FPR, incident volume, responder SLA",
  },
  {
    id: "billing",
    label: "Billing",
    phase: "P2",
    description: "Pilot conversion, venue plan, insurance value proof",
  },
];

const ROADMAP_CONTENT: Record<
  Exclude<DashboardTab, "history" | "live">,
  {
    kicker: string;
    subtitle: string;
    title: string;
    items: Array<{ detail: string; label: string; phase: string }>;
  }
> = {
  setup: {
    title: "Venue setup workspace",
    kicker: "Phase 2 build queue",
    subtitle:
      "Turn one-off demo setup into a repeatable onboarding flow for every venue.",
    items: [
      {
        label: "Floor plan upload + zone annotation",
        detail: "Upload PNG/SVG layouts, mark exits, hydrants, AEDs, and assembly points.",
        phase: "P1",
      },
      {
        label: "Camera + sensor mapping",
        detail: "Bind each CCTV feed and IoT sensor to a zone-aware incident graph.",
        phase: "P1",
      },
      {
        label: "Roster + credentialing",
        detail: "Track shifts, responder skills, expiries, and who can take each incident.",
        phase: "P1",
      },
      {
        label: "Drill schedule + drill mode",
        detail: "Stage incidents without firing real authority webhooks or live public alerts.",
        phase: "P1",
      },
    ],
  },
  compliance: {
    title: "Compliance control plane",
    kicker: "Audit-first operating model",
    subtitle:
      "Every command, dispatch, and override should be legible to insurers, auditors, and civic authorities.",
    items: [
      {
        label: "Hash-chain integrity view",
        detail: "Expose BigQuery audit verification so judges can see tamper evidence live.",
        phase: "P2",
      },
      {
        label: "Sendai report export",
        detail: "Generate post-incident packages aligned to the Sendai disaster reporting framework.",
        phase: "P1",
      },
      {
        label: "Authority packet delivery",
        detail: "Signed JSON-LD incident packets with structured access routes and evidence links.",
        phase: "P1",
      },
      {
        label: "Legal hold + evidence custody",
        detail: "Preserve frames, dispatch logs, and timelines for insurance or legal review.",
        phase: "P3",
      },
    ],
  },
  analytics: {
    title: "Operational analytics",
    kicker: "What the venue team should watch",
    subtitle:
      "Push the dashboard beyond incident viewing into measurable safety performance.",
    items: [
      {
        label: "Dispatch latency trend",
        detail: "Venue-level p50/p95 time from first signal to first responder en route.",
        phase: "P1",
      },
      {
        label: "False positive watchlist",
        detail: "Flag noisy cameras and suspicious classifier drift before operators lose trust.",
        phase: "P2",
      },
      {
        label: "Responder SLA board",
        detail: "Track acknowledgement rates, handoff speed, and after-hours coverage gaps.",
        phase: "P2",
      },
      {
        label: "Risk heatmap",
        detail: "Surface which zones trend toward incidents by hour, day, and event type.",
        phase: "P2",
      },
    ],
  },
  billing: {
    title: "Commercial readiness",
    kicker: "Phase 2 conversion tools",
    subtitle:
      "Translate safety wins into a venue-friendly buying story once the pilot proves itself.",
    items: [
      {
        label: "Pilot scorecard",
        detail: "Show dispatch latency, incident drill outcomes, and staff actioned rate for the buyer.",
        phase: "P2",
      },
      {
        label: "Multi-venue roll-up",
        detail: "Let hotel groups compare properties and target retraining where the SLA slips.",
        phase: "P2",
      },
      {
        label: "Insurance value brief",
        detail: "Package faster response metrics into evidence a broker can use in renewals.",
        phase: "P2",
      },
      {
        label: "Seat + site plans",
        detail: "Gate enterprise features by venue, responder count, and compliance tier.",
        phase: "P2",
      },
    ],
  },
};

const CAMERA_ZONES = [
  "Lobby North",
  "Ballroom West",
  "Kitchen Main",
  "Service Corridor",
  "Atrium",
  "Loading Bay",
] as const;

const DISPATCH_TONE: Record<Dispatch["status"], string> = {
  PAGED: "#F59E0B",
  ACKNOWLEDGED: "#F59E0B",
  DECLINED: "#64748B",
  EN_ROUTE: "#14B8A6",
  ARRIVED: "#10B981",
  HANDED_OFF: "#94A3B8",
  TIMED_OUT: "#DC2626",
};

export default function DashboardHome() {
  const [incidents, setIncidents] = React.useState<Incident[]>([]);
  const [dispatches, setDispatches] = React.useState<Dispatch[]>([]);
  const [venueId, setVenueId] = React.useState<string>(DEFAULT_VENUE_ID);
  const [tab, setTab] = React.useState<DashboardTab>("live");
  const [error, setError] = React.useState<string | null>(null);
  const [dispatchError, setDispatchError] = React.useState<string | null>(null);
  const [isMounted, setIsMounted] = React.useState(false);

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  React.useEffect(() => {
    if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) {
      setError(
        "Firebase not configured. Set NEXT_PUBLIC_FIREBASE_* for dashboard and staff apps.",
      );
      return;
    }
    try {
      const db = getDb();
      const constraints: QueryConstraint[] = [
        where("venue_id", "==", venueId),
        orderBy("detected_at", "desc"),
      ];
      const q = query(collection(db, "incidents"), ...constraints);
      const unsub = onSnapshot(
        q,
        (snap) => {
          const nextIncidents = snap.docs.map((d) => d.data() as Incident);
          React.startTransition(() => setIncidents(nextIncidents));
        },
        (err) => setError(err.message),
      );
      return () => unsub();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [venueId]);

  const deferredIncidents = React.useDeferredValue(incidents);
  const active = deferredIncidents
    .filter((incident) => isActiveIncident(incident))
    .sort(sortIncidents);
  const recent = deferredIncidents
    .filter((incident) => !isActiveIncident(incident))
    .sort(sortIncidents);
  const activeIncidentKey = active
    .slice(0, 6)
    .map((incident) => incident.incident_id)
    .join("|");

  React.useEffect(() => {
    if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) return;
    const incidentIds = activeIncidentKey
      ? activeIncidentKey.split("|").filter(Boolean)
      : [];
    if (!incidentIds.length) {
      setDispatches([]);
      setDispatchError(null);
      return;
    }
    const db = getDb();
    const cache = new Map<string, Dispatch[]>();

    const publish = () => {
      const merged = Array.from(cache.values())
        .flat()
        .sort((left, right) => toEpoch(right.paged_at) - toEpoch(left.paged_at));
      React.startTransition(() => setDispatches(merged));
    };

    const unsubs = incidentIds.map((incidentId) =>
      onSnapshot(
        query(
          collection(db, "incidents", incidentId, "dispatches"),
          orderBy("paged_at", "desc"),
        ),
        (snap) => {
          cache.set(
            incidentId,
            snap.docs.map((docSnap) => docSnap.data() as Dispatch),
          );
          setDispatchError(null);
          publish();
        },
        (err) => setDispatchError(err.message),
      ),
    );

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [activeIncidentKey, venueId]);

  const historicalFeed = [...active, ...recent].sort(sortIncidents);
  const zonePulse = buildZonePulse(active);
  const cameraTiles = buildCameraTiles(active);
  const responderCards = buildResponderCards(dispatches, active);
  const activeCount = active.length;
  const criticalCount = active.filter(
    (incident) => (incident.classification?.severity ?? "S4") === "S1",
  ).length;
  const ownedCount = dispatches.filter((dispatch) =>
    ["ACKNOWLEDGED", "ARRIVED", "EN_ROUTE", "HANDED_OFF"].includes(dispatch.status),
  ).length;
  const avgAge = activeCount
    ? Math.max(
        1,
        Math.round(
          active.reduce(
            (sum, incident) => sum + minutesSince(incident.detected_at),
            0,
          ) / activeCount,
        ),
      )
    : 0;
  const venueState =
    criticalCount > 0 ? "Critical" : activeCount > 0 ? "Elevated" : "Nominal";
  const lastUpdatedAt = historicalFeed[0]?.detected_at ?? "2024-01-01T00:00:00Z";
  const selectedRoadmap =
    tab !== "live" && tab !== "history" ? ROADMAP_CONTENT[tab] : null;

  return (
    <main className="dashboard-shell">
      <div className="dashboard-grid">
        <aside
          className="panel"
          style={{
            padding: 24,
            position: "sticky",
            top: 24,
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          <div className="eyebrow">AEGIS · CONTROL ROOM</div>
          <div>
            <h1
              style={{
                margin: "6px 0 8px",
                fontSize: "clamp(2rem, 2vw + 1.4rem, 3rem)",
                lineHeight: 1.02,
              }}
            >
              Venue dashboard
            </h1>
            <p
              style={{
                margin: 0,
                color: "var(--c-ink-secondary)",
                fontSize: 14,
              }}
            >
              Desktop board for duty managers. Watch live incidents, monitor responders,
              and stage drill flows without leaving the control room.
            </p>
          </div>

          <div
            style={{
              padding: 16,
              borderRadius: 18,
              background: "rgba(8, 15, 24, 0.72)",
              border: "1px solid rgba(51, 65, 85, 0.92)",
              display: "grid",
              gap: 12,
            }}
          >
            <div className="eyebrow">Venue selection</div>
            <select value={venueId} onChange={(e) => setVenueId(e.target.value)}>
              <option value="taj-ahmedabad">taj-ahmedabad</option>
              <option value="house-of-mg">house-of-mg</option>
              <option value="demo-venue">demo-venue</option>
            </select>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 13,
                color: "var(--c-ink-secondary)",
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background:
                    venueState === "Critical"
                      ? "#DC2626"
                      : venueState === "Elevated"
                        ? "#F59E0B"
                        : "#10B981",
                  boxShadow:
                    venueState === "Critical"
                      ? "0 0 18px rgba(220, 38, 38, 0.55)"
                      : venueState === "Elevated"
                        ? "0 0 18px rgba(245, 158, 11, 0.45)"
                        : "0 0 16px rgba(16, 185, 129, 0.4)",
                }}
              />
              {venueState} venue state
            </div>
          </div>

          <div className="divider" />

          <div style={{ display: "grid", gap: 8 }}>
            {NAV_ITEMS.map((item) => {
              const activeTab = tab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "14px 16px",
                    borderRadius: 16,
                    border: activeTab
                      ? "1px solid rgba(20, 184, 166, 0.7)"
                      : "1px solid rgba(51, 65, 85, 0.92)",
                    background: activeTab
                      ? "linear-gradient(135deg, rgba(20, 184, 166, 0.16), rgba(10, 14, 20, 0.55))"
                      : "rgba(10, 14, 20, 0.55)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: 15, fontWeight: 600 }}>{item.label}</span>
                    <span
                      className="eyebrow"
                      style={{
                        padding: "4px 8px",
                        borderRadius: 999,
                        background: "rgba(255, 255, 255, 0.04)",
                        border: "1px solid rgba(51, 65, 85, 0.92)",
                      }}
                    >
                      {item.phase}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 12.5,
                      color: activeTab
                        ? "rgba(226, 232, 240, 0.88)"
                        : "var(--c-ink-muted)",
                    }}
                  >
                    {item.description}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="divider" />

          <div style={{ display: "grid", gap: 10 }}>
            <QuickLink href="/drill" label="Drill console" detail="Trigger synthetic incidents end-to-end." />
            <QuickLink href="/profile" label="Venue profile" detail="Demo venue identity, links, auth note." />
            <QuickLink
              href={process.env.NEXT_PUBLIC_STAFF_URL || "http://localhost:3001"}
              label="Staff surface"
              detail="Open responder-facing mobile flow for the same venue."
              external
            />
          </div>

          <div
            style={{
              marginTop: "auto",
              padding: 16,
              borderRadius: 18,
              background:
                "linear-gradient(180deg, rgba(20, 184, 166, 0.12), rgba(15, 23, 42, 0.6))",
              border: "1px solid rgba(20, 184, 166, 0.28)",
            }}
          >
            <div className="eyebrow">Mission</div>
            <div style={{ marginTop: 10, fontSize: 14, color: "var(--c-ink-secondary)" }}>
              Keep Dispatch Latency under 60 seconds. Firestore snapshots refresh the board
              automatically every time the venue state shifts.
            </div>
          </div>
        </aside>

        <section style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <section className="panel" style={{ padding: 28 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              <div style={{ maxWidth: 880 }}>
                <div className="eyebrow">{venueId}</div>
                <h2
                  style={{
                    margin: "10px 0 10px",
                    fontSize: "clamp(2.1rem, 2vw + 1.3rem, 3.45rem)",
                    lineHeight: 1.05,
                  }}
                >
                  {tab === "live"
                    ? "Live venue operations"
                    : tab === "history"
                      ? "Incident history and audit trail"
                      : selectedRoadmap?.title}
                </h2>
                <p
                  style={{
                    margin: 0,
                    color: "var(--c-ink-secondary)",
                    fontSize: 15,
                    maxWidth: 760,
                  }}
                >
                  {tab === "live"
                    ? "Blend the incident feed, active responder board, and a camera-first view into one control-room surface."
                    : tab === "history"
                      ? "Review recently handled incidents, closures, and drill traces without leaving the dashboard."
                      : selectedRoadmap?.subtitle}
                </p>
              </div>

              <div
                style={{
                  minWidth: 280,
                  padding: 18,
                  borderRadius: 18,
                  background: "rgba(8, 15, 24, 0.72)",
                  border: "1px solid rgba(51, 65, 85, 0.92)",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div className="eyebrow">Command snapshot</div>
                <div style={{ fontSize: 26, fontWeight: 700 }}>{venueState}</div>
                <div style={{ color: "var(--c-ink-secondary)", fontSize: 13 }}>
                  {criticalCount > 0
                    ? `${criticalCount} severity-1 incident${criticalCount === 1 ? "" : "s"} demand attention now.`
                    : activeCount > 0
                      ? `${activeCount} live incident${activeCount === 1 ? "" : "s"} still open on the board.`
                      : "No active incidents. Venue appears nominal right now."}
                </div>
                <div className="eyebrow" style={{ marginTop: 8 }}>
                  Last signal {isMounted ? formatClock(lastUpdatedAt) : "--:--:--"}
                </div>
              </div>
            </div>
          </section>

          {tab === "live" ? (
            <>
              <div className="metric-grid">
                <StatTile
                  accent="#14B8A6"
                  label="Live incidents"
                  value={String(activeCount)}
                  caption="Realtime Firestore feed"
                />
                <StatTile
                  accent="#DC2626"
                  label="Sev-1 pressure"
                  value={String(criticalCount)}
                  caption="Incidents needing immediate containment"
                />
                <StatTile
                  accent="#F59E0B"
                  label="Owned dispatches"
                  value={String(ownedCount)}
                  caption="Responders acknowledged or moving"
                />
                <StatTile
                  accent="#3B82F6"
                  label="Avg incident age"
                  value={activeCount ? `${avgAge}m` : "0m"}
                  caption="How long current cases have stayed open"
                />
              </div>

              <div className="live-grid">
                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                  <Panel
                    title="Active feed"
                    kicker={`${activeCount} live on this venue`}
                    action={<Link href="/drill">Launch drill</Link>}
                  >
                    {error ? (
                      <Callout tone="#DC2626">{error}</Callout>
                    ) : active.length === 0 ? (
                      <EmptyState
                        title="Venue nominal"
                        description="No active incidents. Aegis is still listening for new signals and dispatch activity."
                      />
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        {active.map((incident) => (
                          <Link
                            key={incident.incident_id}
                            href={`/incident/${incident.incident_id}`}
                            style={{ color: "inherit" }}
                          >
                            <IncidentCard incident={incident} />
                          </Link>
                        ))}
                      </div>
                    )}
                  </Panel>

                  <Panel title="Zone pulse" kicker="Severity by area">
                    <div className="zone-grid">
                      {zonePulse.map((zone) => (
                        <div
                          key={zone.zoneId}
                          style={{
                            padding: 16,
                            borderRadius: 18,
                            background: "rgba(8, 15, 24, 0.7)",
                            border: `1px solid ${SEVERITY_COLOR[zone.severity]}55`,
                            display: "grid",
                            gap: 10,
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 10,
                              alignItems: "center",
                            }}
                          >
                            <div>
                              <div className="eyebrow">Zone</div>
                              <div style={{ marginTop: 4, fontSize: 18, fontWeight: 600 }}>
                                {zone.zoneId}
                              </div>
                            </div>
                            <SeverityBadge severity={zone.severity} size="sm" />
                          </div>
                          <div style={{ color: "var(--c-ink-secondary)", fontSize: 13 }}>
                            {zone.summary}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 8,
                              fontSize: 12,
                              color: "var(--c-ink-muted)",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            <span>{zone.status}</span>
                            <span>{zone.incidents} live</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Panel>

                  <Panel title="Recent closures" kicker="Most recently resolved or dismissed">
                    {recent.length === 0 ? (
                      <EmptyState
                        title="No closure history yet"
                        description="Resolved and dismissed incidents will land here for quick after-action review."
                      />
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {recent.slice(0, 8).map((incident) => (
                          <Link
                            key={incident.incident_id}
                            href={`/incident/${incident.incident_id}`}
                            style={{ color: "inherit" }}
                          >
                            <IncidentCard incident={incident} compact />
                          </Link>
                        ))}
                      </div>
                    )}
                  </Panel>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                  <Panel
                    title="Camera mosaic"
                    kicker="Desktop evidence wall"
                    action={<span style={{ color: "var(--c-ink-muted)" }}>Judge-demo ready</span>}
                  >
                    <div className="camera-grid">
                      {cameraTiles.map((tile) => {
                        const tileBody = (
                          <div
                            style={{
                              minHeight: 184,
                              borderRadius: 20,
                              padding: 16,
                              position: "relative",
                              overflow: "hidden",
                              display: "flex",
                              flexDirection: "column",
                              justifyContent: "space-between",
                              background:
                                tile.highlight
                                  ? `linear-gradient(180deg, rgba(10, 14, 20, 0.08), rgba(10, 14, 20, 0.88)), url('/demo-frame.jpg')`
                                  : "linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(8, 15, 24, 0.92))",
                              backgroundSize: "cover",
                              backgroundPosition: "center",
                              border: `1px solid ${SEVERITY_COLOR[tile.severity]}55`,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                gap: 10,
                                alignItems: "start",
                              }}
                            >
                              <div>
                                <div className="eyebrow">Feed · {tile.zoneId}</div>
                                <div
                                  style={{
                                    marginTop: 8,
                                    fontSize: 20,
                                    fontWeight: 700,
                                    lineHeight: 1.05,
                                  }}
                                >
                                  {tile.headline}
                                </div>
                              </div>
                              <SeverityBadge severity={tile.severity} size="sm" />
                            </div>
                            <div>
                              <div
                                style={{
                                  color: "var(--c-ink-secondary)",
                                  fontSize: 13,
                                  maxWidth: 260,
                                }}
                              >
                                {tile.summary}
                              </div>
                              <div
                                style={{
                                  marginTop: 10,
                                  display: "flex",
                                  justifyContent: "space-between",
                                  gap: 8,
                                  fontSize: 12,
                                  color: "rgba(226, 232, 240, 0.86)",
                                  fontFamily: "var(--font-mono)",
                                }}
                              >
                                <span>{tile.status}</span>
                                <span>{isMounted ? formatSince(tile.timestamp) : "..."}</span>
                              </div>
                            </div>
                          </div>
                        );

                        return tile.incidentId ? (
                          <Link
                            key={`${tile.zoneId}-${tile.incidentId}`}
                            href={`/incident/${tile.incidentId}`}
                            style={{ color: "inherit" }}
                          >
                            {tileBody}
                          </Link>
                        ) : (
                          <div key={tile.zoneId}>{tileBody}</div>
                        );
                      })}
                    </div>
                  </Panel>

                  <Panel
                    title="Responder positions"
                    kicker={
                      dispatchError
                        ? "Dispatch subcollection read degraded"
                        : `${responderCards.length} active responder view`
                    }
                  >
                    {dispatchError ? <Callout tone="#F59E0B">{dispatchError}</Callout> : null}
                    {responderCards.length === 0 ? (
                      <EmptyState
                        title="No responders moving"
                        description="Once a dispatch is paged, acknowledgements and on-route movement appear here."
                      />
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {responderCards.map((card) => (
                          <Link
                            key={card.dispatchId}
                            href={`/incident/${card.incidentId}`}
                            style={{ color: "inherit" }}
                          >
                            <div
                              style={{
                                padding: 14,
                                borderRadius: 18,
                                background: "rgba(8, 15, 24, 0.7)",
                                border: "1px solid rgba(51, 65, 85, 0.9)",
                                display: "grid",
                                gap: 8,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  gap: 10,
                                  alignItems: "center",
                                }}
                              >
                                <div>
                                  <div style={{ fontSize: 16, fontWeight: 600 }}>
                                    {card.responderId}
                                  </div>
                                  <div style={{ color: "var(--c-ink-muted)", fontSize: 13 }}>
                                    {card.role}
                                  </div>
                                </div>
                                <DispatchBadge status={card.status} />
                              </div>
                              <div style={{ color: "var(--c-ink-secondary)", fontSize: 13 }}>
                                Zone · {card.zoneId}
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  gap: 8,
                                  fontSize: 12,
                                  color: "var(--c-ink-muted)",
                                  fontFamily: "var(--font-mono)",
                                }}
                              >
                                <span>{card.notes || "Awaiting field note"}</span>
                                <span>{isMounted ? formatSince(card.timestamp) : "..."}</span>
                              </div>
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}
                  </Panel>

                  <Panel title="Command rail" kicker="What to show next">
                    <div className="roadmap-grid">
                      <RailCard
                        title="Trigger a judge drill"
                        detail="Use the drill console to run the complete ingest → vision → orchestrator path live."
                        href="/drill"
                      />
                      <RailCard
                        title="Inspect a live incident"
                        detail="Open any active card to see the evidence panel, cascade outlook, and dispatch ladder."
                        href={active[0] ? `/incident/${active[0].incident_id}` : "/profile"}
                      />
                      <RailCard
                        title="Show roadmap ambition"
                        detail="Flip to Setup or Analytics to telegraph where Product Vault expands this dashboard."
                      />
                      <RailCard
                        title="Open staff mobile view"
                        detail="Pair the command board with the responder-facing app during the demo."
                        href={process.env.NEXT_PUBLIC_STAFF_URL || "http://localhost:3001"}
                        external
                      />
                    </div>
                  </Panel>
                </div>
              </div>
            </>
          ) : tab === "history" ? (
            <>
              <div className="metric-grid">
                <StatTile
                  accent="#3B82F6"
                  label="Tracked incidents"
                  value={String(historicalFeed.length)}
                  caption="All items currently visible for this venue"
                />
                <StatTile
                  accent="#10B981"
                  label="Resolved"
                  value={String(
                    historicalFeed.filter((incident) => incident.status === "CLOSED").length,
                  )}
                  caption="Closed incidents"
                />
                <StatTile
                  accent="#64748B"
                  label="Dismissed"
                  value={String(
                    historicalFeed.filter((incident) => incident.status === "DISMISSED").length,
                  )}
                  caption="Cleared as false or nuisance"
                />
                <StatTile
                  accent="#F59E0B"
                  label="Open now"
                  value={String(activeCount)}
                  caption="Still active on the operations board"
                />
              </div>

              <Panel title="Incident log" kicker="Latest first">
                {error ? <Callout tone="#DC2626">{error}</Callout> : null}
                {historicalFeed.length === 0 ? (
                  <EmptyState
                    title="No incidents recorded yet"
                    description="When the venue starts generating incidents or drills, this log becomes the review surface."
                  />
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {historicalFeed.map((incident) => {
                      const severity = incident.classification?.severity ?? "S4";
                      return (
                        <Link
                          key={incident.incident_id}
                          href={`/incident/${incident.incident_id}`}
                          style={{ color: "inherit" }}
                        >
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "minmax(0, 1.4fr) auto auto auto",
                              gap: 12,
                              alignItems: "center",
                              padding: "16px 18px",
                              borderRadius: 18,
                              background: "rgba(8, 15, 24, 0.72)",
                              border: "1px solid rgba(51, 65, 85, 0.92)",
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 16, fontWeight: 600 }}>
                                {incident.classification?.category ?? "OTHER"} · {incident.zone_id}
                              </div>
                              <div
                                style={{
                                  color: "var(--c-ink-secondary)",
                                  fontSize: 13,
                                  marginTop: 4,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {incident.summary || incident.classification?.rationale || "—"}
                              </div>
                            </div>
                            <SeverityBadge severity={severity} size="sm" />
                            <div
                              className="eyebrow"
                              style={{ minWidth: 96, textAlign: "right" }}
                            >
                              {incident.status}
                            </div>
                            <div
                              style={{
                                color: "var(--c-ink-muted)",
                                fontSize: 12,
                                fontFamily: "var(--font-mono)",
                                minWidth: 84,
                                textAlign: "right",
                              }}
                            >
                              {isMounted ? formatSince(incident.detected_at) : "..."}
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </Panel>
            </>
          ) : selectedRoadmap ? (
            <>
              <div className="metric-grid">
                <StatTile
                  accent="#14B8A6"
                  label="Today"
                  value={tab.toUpperCase()}
                  caption="Current design slice in this dashboard"
                />
                <StatTile
                  accent="#3B82F6"
                  label="Phase"
                  value={selectedRoadmap.items[0]?.phase ?? "P1"}
                  caption={selectedRoadmap.kicker}
                />
                <StatTile
                  accent="#F59E0B"
                  label="Tasks"
                  value={String(selectedRoadmap.items.length)}
                  caption="Major capabilities queued here"
                />
                <StatTile
                  accent="#DC2626"
                  label="Goal"
                  value="Ship"
                  caption="Turn roadmap into a venue-ready surface"
                />
              </div>

              <Panel title={selectedRoadmap.title} kicker={selectedRoadmap.kicker}>
                <p
                  style={{
                    margin: "0 0 18px",
                    color: "var(--c-ink-secondary)",
                    fontSize: 15,
                    maxWidth: 860,
                  }}
                >
                  {selectedRoadmap.subtitle}
                </p>
                <div className="roadmap-grid">
                  {selectedRoadmap.items.map((item) => (
                    <div
                      key={item.label}
                      style={{
                        padding: 18,
                        borderRadius: 18,
                        background: "rgba(8, 15, 24, 0.72)",
                        border: "1px solid rgba(51, 65, 85, 0.92)",
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <div style={{ fontSize: 16, fontWeight: 600 }}>{item.label}</div>
                        <span
                          className="eyebrow"
                          style={{
                            padding: "4px 8px",
                            borderRadius: 999,
                            background: "rgba(255, 255, 255, 0.04)",
                            border: "1px solid rgba(51, 65, 85, 0.92)",
                          }}
                        >
                          {item.phase}
                        </span>
                      </div>
                      <div style={{ color: "var(--c-ink-secondary)", fontSize: 13 }}>
                        {item.detail}
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function Panel({
  title,
  kicker,
  action,
  children,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  kicker?: string;
  title: string;
}) {
  return (
    <section className="panel" style={{ padding: 22 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "end",
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div className="eyebrow">{kicker ?? "Live surface"}</div>
          <h3 style={{ margin: "8px 0 0", fontSize: 24 }}>{title}</h3>
        </div>
        {action ? (
          <div
            style={{
              fontSize: 12,
              color: "var(--c-ink-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {action}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function StatTile({
  accent,
  label,
  value,
  caption,
}: {
  accent: string;
  caption: string;
  label: string;
  value: string;
}) {
  return (
    <div
      className="panel"
      style={{
        padding: 18,
        borderColor: `${accent}55`,
        display: "grid",
        gap: 8,
      }}
    >
      <div className="eyebrow">{label}</div>
      <div style={{ fontSize: "clamp(1.9rem, 1vw + 1.3rem, 2.6rem)", fontWeight: 700 }}>
        {value}
      </div>
      <div style={{ color: "var(--c-ink-secondary)", fontSize: 13 }}>{caption}</div>
    </div>
  );
}

function Callout({
  tone,
  children,
}: {
  children: React.ReactNode;
  tone: string;
}) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 16,
        background: "rgba(8, 15, 24, 0.72)",
        border: `1px solid ${tone}`,
        color: "var(--c-ink-secondary)",
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  description: string;
  title: string;
}) {
  return (
    <div
      style={{
        padding: 24,
        borderRadius: 18,
        border: "1px dashed rgba(51, 65, 85, 0.92)",
        background: "rgba(8, 15, 24, 0.55)",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600 }}>{title}</div>
      <div style={{ marginTop: 8, color: "var(--c-ink-secondary)", fontSize: 13 }}>
        {description}
      </div>
    </div>
  );
}

function QuickLink({
  href,
  label,
  detail,
  external,
}: {
  detail: string;
  external?: boolean;
  href: string;
  label: string;
}) {
  const content = (
    <div
      style={{
        padding: 14,
        borderRadius: 16,
        background: "rgba(8, 15, 24, 0.55)",
        border: "1px solid rgba(51, 65, 85, 0.92)",
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600 }}>{label}</div>
      <div style={{ marginTop: 4, color: "var(--c-ink-muted)", fontSize: 12.5 }}>
        {detail}
      </div>
    </div>
  );

  return external ? (
    <a href={href}>{content}</a>
  ) : (
    <Link href={href}>{content}</Link>
  );
}

function RailCard({
  title,
  detail,
  href,
  external,
}: {
  detail: string;
  external?: boolean;
  href?: string;
  title: string;
}) {
  const content = (
    <div
      style={{
        padding: 16,
        borderRadius: 18,
        background: "rgba(8, 15, 24, 0.72)",
        border: "1px solid rgba(51, 65, 85, 0.92)",
        minHeight: 128,
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
      <div style={{ color: "var(--c-ink-secondary)", fontSize: 13 }}>{detail}</div>
      {href ? (
        <div className="eyebrow" style={{ marginTop: "auto" }}>
          Open →
        </div>
      ) : (
        <div className="eyebrow" style={{ marginTop: "auto" }}>
          Roadmap
        </div>
      )}
    </div>
  );

  if (!href) return content;
  return external ? <a href={href}>{content}</a> : <Link href={href}>{content}</Link>;
}

function DispatchBadge({ status }: { status: Dispatch["status"] }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        borderRadius: 999,
        border: `1px solid ${DISPATCH_TONE[status]}`,
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        color: "var(--c-ink-primary)",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: DISPATCH_TONE[status],
        }}
      />
      {status}
    </span>
  );
}

function buildZonePulse(incidents: Incident[]): ZonePulseCardData[] {
  if (!incidents.length) {
    return CAMERA_ZONES.slice(0, 4).map((zoneId) => ({
      zoneId,
      incidents: 0,
      severity: "S4",
      status: "Nominal watch",
      summary: "No elevated signal in the current venue snapshot.",
      updatedAt: new Date().toISOString(),
    }));
  }

  const grouped = new Map<string, Incident[]>();
  for (const incident of incidents) {
    const zoneId = incident.zone_id || "unknown-zone";
    grouped.set(zoneId, [...(grouped.get(zoneId) ?? []), incident]);
  }

  return Array.from(grouped.entries())
    .map(([zoneId, zoneIncidents]) => {
      const lead = [...zoneIncidents].sort(sortIncidents)[0]!;
      const severity = zoneIncidents.reduce<Severity>(
        (current, incident) => {
          const next = incident.classification?.severity ?? "S4";
          return severityRank(next) > severityRank(current) ? next : current;
        },
        "S4",
      );
      return {
        zoneId,
        incidents: zoneIncidents.length,
        severity,
        status:
          severity === "S1"
            ? "Lock down + dispatch"
            : severity === "S2"
              ? "Contain + route staff"
              : "Monitor and verify",
        summary:
          lead.summary ||
          lead.classification?.rationale ||
          "Multiple signals are clustering in this zone.",
        updatedAt: lead.detected_at,
      };
    })
    .sort((left, right) => {
      const severityDelta =
        severityRank(right.severity) - severityRank(left.severity);
      if (severityDelta !== 0) return severityDelta;
      return toEpoch(right.updatedAt) - toEpoch(left.updatedAt);
    });
}

function buildCameraTiles(incidents: Incident[]): CameraTileData[] {
  const liveTiles = incidents.slice(0, 4).map((incident) => ({
    zoneId: incident.zone_id || "unknown-zone",
    headline: incident.classification?.category ?? "OTHER",
    severity: incident.classification?.severity ?? "S4",
    status: "Live anomaly",
    summary:
      incident.summary ||
      incident.classification?.rationale ||
      "Classifier raised an incident on this camera feed.",
    timestamp: incident.detected_at,
    incidentId: incident.incident_id,
    highlight: true,
  }));

  const usedZones = new Set(liveTiles.map((tile) => tile.zoneId));
  const fillerTiles = CAMERA_ZONES.filter((zone) => !usedZones.has(zone))
    .slice(0, Math.max(0, 6 - liveTiles.length))
    .map((zoneId) => ({
      zoneId,
      headline: "Nominal",
      severity: "S4" as Severity,
      status: "Monitoring",
      summary: "Feed online. No elevated signal in the recent venue snapshot.",
      timestamp: new Date().toISOString(),
      highlight: false,
    }));

  return [...liveTiles, ...fillerTiles];
}

function buildResponderCards(
  dispatches: Dispatch[],
  incidents: Incident[],
): ResponderCardData[] {
  if (!dispatches.length) return [];

  const latestByResponder = new Map<string, Dispatch>();
  for (const dispatch of [...dispatches].sort(
    (left, right) => toEpoch(right.paged_at) - toEpoch(left.paged_at),
  )) {
    if (!latestByResponder.has(dispatch.responder_id)) {
      latestByResponder.set(dispatch.responder_id, dispatch);
    }
  }

  const incidentById = new Map(
    incidents.map((incident) => [incident.incident_id, incident]),
  );

  return Array.from(latestByResponder.values())
    .map((dispatch) => ({
      dispatchId: dispatch.dispatch_id,
      incidentId: dispatch.incident_id,
      notes: dispatch.notes,
      responderId: dispatch.responder_id,
      role: dispatch.role,
      status: dispatch.status,
      timestamp:
        dispatch.arrived_at ??
        dispatch.en_route_at ??
        dispatch.acknowledged_at ??
        dispatch.paged_at,
      zoneId:
        incidentById.get(dispatch.incident_id)?.zone_id ?? "Awaiting zone sync",
    }))
    .sort((left, right) => {
      const toneDelta = dispatchRank(right.status) - dispatchRank(left.status);
      if (toneDelta !== 0) return toneDelta;
      return toEpoch(right.timestamp) - toEpoch(left.timestamp);
    });
}

function isActiveIncident(incident: Incident): boolean {
  return !["CLOSED", "DISMISSED", "VERIFIED"].includes(incident.status);
}

function sortIncidents(left: Incident, right: Incident): number {
  const severityDelta =
    severityRank(right.classification?.severity ?? "S4") -
    severityRank(left.classification?.severity ?? "S4");
  if (severityDelta !== 0) return severityDelta;
  return toEpoch(right.detected_at) - toEpoch(left.detected_at);
}

function severityRank(severity: Severity): number {
  return { S1: 4, S2: 3, S3: 2, S4: 1 }[severity];
}

function dispatchRank(status: Dispatch["status"]): number {
  return {
    ARRIVED: 5,
    EN_ROUTE: 4,
    ACKNOWLEDGED: 3,
    PAGED: 2,
    HANDED_OFF: 1,
    TIMED_OUT: 0,
    DECLINED: -1,
  }[status];
}

function formatSince(value: unknown): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - toEpoch(value)) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  return `${Math.floor(elapsedSeconds / 3600)}h ago`;
}

function formatClock(value: unknown): string {
  return toDate(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function minutesSince(value: unknown): number {
  return Math.max(0, Math.round((Date.now() - toEpoch(value)) / 60000));
}

function toEpoch(value: unknown): number {
  const date = toDate(value);
  const epoch = date.getTime();
  return Number.isFinite(epoch) ? epoch : Date.now();
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    const converted = (value as { toDate: () => Date }).toDate();
    if (converted instanceof Date) return converted;
  }
  if (
    value &&
    typeof value === "object" &&
    "seconds" in value &&
    typeof (value as { seconds?: unknown }).seconds === "number"
  ) {
    const seconds = (value as { seconds: number }).seconds;
    const nanos =
      "nanoseconds" in value && typeof (value as { nanoseconds?: unknown }).nanoseconds === "number"
        ? (value as { nanoseconds: number }).nanoseconds
        : 0;
    return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000));
  }
  return new Date();
}
