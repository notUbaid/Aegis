"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  getDb,
  SeverityBadge,
  CountdownRing,
  SEVERITY_COLOR,
  type Dispatch,
  type Incident,
  type IncidentEvent,
  StatusPill,
} from "@aegis/ui-web";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";

const DISPATCH_BASE =
  process.env.NEXT_PUBLIC_DISPATCH_URL || "http://localhost:8004";
const ACK_COUNTDOWN_SECONDS = 15;
type DispatchAction = "ack" | "arrived" | "decline" | "enroute" | "handoff";

const DISPATCH_TONE: Record<Dispatch["status"], string> = {
  PAGED: "#F59E0B",
  ACKNOWLEDGED: "#F59E0B",
  DECLINED: "#64748B",
  EN_ROUTE: "#14B8A6",
  ARRIVED: "#10B981",
  HANDED_OFF: "#94A3B8",
  TIMED_OUT: "#DC2626",
};

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [incident, setIncident] = React.useState<Incident | null>(null);
  const [dispatches, setDispatches] = React.useState<Dispatch[]>([]);
  const [events, setEvents] = React.useState<IncidentEvent[]>([]);
  const [acting, setActing] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [countdownKey, setCountdownKey] = React.useState(0);
  const [isMounted, setIsMounted] = React.useState(false);

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  React.useEffect(() => {
    if (!id || !process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) return;
    const db = getDb();
    const unsubI = onSnapshot(doc(db, "incidents", id), (snap) => {
      if (snap.exists()) setIncident(snap.data() as Incident);
    });
    const unsubD = onSnapshot(
      query(
        collection(db, "incidents", id, "dispatches"),
        orderBy("paged_at", "asc"),
      ),
      (snap) => setDispatches(snap.docs.map((d) => d.data() as Dispatch)),
    );
    const unsubE = onSnapshot(
      query(
        collection(db, "incidents", id, "events"),
        orderBy("event_time", "asc"),
      ),
      (snap) => setEvents(snap.docs.map((d) => d.data() as IncidentEvent)),
    );
    return () => {
      unsubI();
      unsubD();
      unsubE();
    };
  }, [id]);

  const severity = incident?.classification?.severity ?? "S4";
  const category = incident?.classification?.category ?? "OTHER";
  const primary = dispatches[0] ?? null;
  const predictions = incident?.classification?.cascade_predictions ?? [];
  const playbook = buildPlaybook(incident);
  const confidence = incident?.classification?.confidence
    ? `${Math.round(incident.classification.confidence * 100)}% confidence`
    : "Awaiting classification";
  const canAck = primary?.status === "PAGED";
  const canDecline = primary?.status === "PAGED";
  const canEnRoute =
    primary !== null &&
    ["ACKNOWLEDGED", "EN_ROUTE", "PAGED"].includes(primary.status);
  const canArrive =
    primary !== null &&
    ["ACKNOWLEDGED", "ARRIVED", "EN_ROUTE"].includes(primary.status);
  const canHandoff =
    primary !== null && ["ARRIVED", "HANDED_OFF"].includes(primary.status);

  async function act(path: DispatchAction) {
    if (!primary) return;
    setActionError(null);
    setActing(true);
    try {
      const response = await fetch(
        `${DISPATCH_BASE}/v1/dispatches/${primary.dispatch_id}/${path}`,
        {
          method: "POST",
        },
      );
      if (!response.ok) {
        throw new Error(`dispatch ${path} failed with ${response.status}`);
      }
      setCountdownKey((k) => k + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  return (
    <main className="dashboard-shell">
      <div
        style={{
          maxWidth: 1600,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <header className="panel" style={{ padding: 28 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 20,
              flexWrap: "wrap",
            }}
          >
            <div style={{ maxWidth: 880 }}>
              <Link
                href="/"
                style={{
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  color: "var(--c-ink-muted)",
                }}
              >
                ← Back to live board
              </Link>
              <div className="eyebrow" style={{ marginTop: 16 }}>
                INCIDENT · {id}
              </div>
              <h1
                style={{
                  margin: "10px 0 10px",
                  fontSize: "clamp(2.1rem, 2vw + 1.4rem, 3.6rem)",
                  lineHeight: 1.02,
                }}
              >
                {category}
              </h1>
              <p
                style={{
                  margin: 0,
                  color: "var(--c-ink-secondary)",
                  fontSize: 15,
                  maxWidth: 760,
                }}
              >
                {incident?.summary ||
                  incident?.classification?.rationale ||
                  "Live control-room view for this incident. Monitor evidence, cascade risk, and dispatch state here."}
              </p>
              <div
                style={{
                  marginTop: 16,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <SeverityBadge severity={severity} />
                {incident ? <StatusPill status={incident.status} /> : null}
                <MetaChip label={`Zone · ${incident?.zone_id ?? "Unknown"}`} />
                 <MetaChip label={confidence} />
                <MetaChip
                  label={`Detected ${
                    isMounted
                      ? formatClock(incident?.detected_at ?? "2024-01-01T00:00:00Z")
                      : "--:--:--"
                  }`}
                />
              </div>
            </div>

            <div
              style={{
                minWidth: 320,
                display: "grid",
                gap: 14,
                alignSelf: "stretch",
              }}
            >
              <div
                className="panel"
                style={{
                  padding: 18,
                  borderColor: `${SEVERITY_COLOR[severity]}55`,
                  background: "rgba(8, 15, 24, 0.72)",
                }}
              >
                <div className="eyebrow">Dispatch clock</div>
                {primary && primary.status === "PAGED" ? (
                  <div
                    style={{
                      marginTop: 14,
                      display: "flex",
                      gap: 14,
                      alignItems: "center",
                    }}
                  >
                    <CountdownRing
                      key={countdownKey}
                      totalSeconds={ACK_COUNTDOWN_SECONDS}
                      color={SEVERITY_COLOR[severity]}
                      onComplete={() => void 0}
                      size={68}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 19, fontWeight: 700 }}>
                        {primary.notes || "Responder paging in progress"}
                      </div>
                      <div
                        style={{
                          marginTop: 6,
                          color: "var(--c-ink-secondary)",
                          fontSize: 13,
                        }}
                      >
                        Escalates automatically in {ACK_COUNTDOWN_SECONDS}s if nobody claims
                        the incident.
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 19, fontWeight: 700 }}>
                      {primary ? primary.status : "Awaiting dispatch"}
                    </div>
                    <div
                      style={{
                        marginTop: 6,
                        color: "var(--c-ink-secondary)",
                        fontSize: 13,
                      }}
                    >
                      {primary
                        ? `${primary.responder_id} currently owns the primary dispatch thread.`
                        : "Dispatch service has not published a responder assignment yet."}
                    </div>
                  </div>
                )}
              </div>

              <div
                style={{
                  padding: 18,
                  borderRadius: 18,
                  background: "rgba(8, 15, 24, 0.72)",
                  border: "1px solid rgba(51, 65, 85, 0.92)",
                }}
              >
                <div className="eyebrow">Situation snapshot</div>
                <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                  <SnapshotRow label="Live dispatches" value={String(dispatches.length)} />
                  <SnapshotRow label="Timeline events" value={String(events.length)} />
                   <SnapshotRow
                    label="Last state change"
                    value={
                      isMounted
                        ? formatClock(
                            events[events.length - 1]?.event_time ??
                              incident?.detected_at ??
                              "2024-01-01T00:00:00Z",
                          )
                        : "--:--:--"
                    }
                  />
                </div>
              </div>
            </div>
          </div>
        </header>

        <div className="detail-grid">
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <Panel
              title="Evidence panel"
              kicker="Demo frame + live overlay"
              action={
                <span style={{ color: "var(--c-ink-muted)" }}>
                  {incident?.zone_id ?? "Demo feed"}
                </span>
              }
            >
              <div
                style={{
                  position: "relative",
                  minHeight: 360,
                  borderRadius: 22,
                  overflow: "hidden",
                  border: `1px solid ${SEVERITY_COLOR[severity]}66`,
                  backgroundImage:
                    "linear-gradient(180deg, rgba(10, 14, 20, 0.08), rgba(10, 14, 20, 0.86)), url('/demo-frame.jpg')",
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  padding: 18,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    alignItems: "start",
                  }}
                >
                  <div
                    style={{
                      padding: "6px 10px",
                      borderRadius: 999,
                      background: "rgba(8, 15, 24, 0.72)",
                      border: "1px solid rgba(51, 65, 85, 0.92)",
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    LIVE CAMERA
                  </div>
                  <SeverityBadge severity={severity} size="sm" />
                </div>

                <div
                  style={{
                    padding: 18,
                    borderRadius: 18,
                    background: "rgba(8, 15, 24, 0.74)",
                    border: "1px solid rgba(51, 65, 85, 0.92)",
                    maxWidth: 620,
                  }}
                >
                  <div className="eyebrow">{incident?.zone_id ?? "Venue zone"}</div>
                  <div style={{ marginTop: 8, fontSize: 28, fontWeight: 700, lineHeight: 1.06 }}>
                    {incident?.classification?.sub_type
                      ? `${category} · ${incident.classification.sub_type}`
                      : category}
                  </div>
                  <div
                    style={{
                      marginTop: 8,
                      color: "var(--c-ink-secondary)",
                      fontSize: 14,
                    }}
                  >
                    {incident?.classification?.rationale ||
                      "Classifier rationale will appear here once the incident record syncs."}
                  </div>
                   <div
                    style={{
                      marginTop: 14,
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    <MetaChip
                      label={`Detected ${
                        isMounted
                          ? formatSince(incident?.detected_at ?? "2024-01-01T00:00:00Z")
                          : "..."
                      }`}
                    />
                    <MetaChip label={incident?.incident_id ?? id} />
                    <MetaChip label={incident?.status ?? "Pending sync"} />
                  </div>
                </div>
              </div>
            </Panel>

            <Panel
              title="Cascade forecast"
              kicker={
                predictions.length
                  ? "30 / 90 / 300 second outlook"
                  : "No cascade prediction returned"
              }
            >
              {predictions.length === 0 ? (
                <EmptyState
                  title="No cascade model output yet"
                  description="When the classifier returns predictions, this panel turns into a quick escalation curve for the duty manager."
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {predictions.map((prediction) => (
                    <div key={`${prediction.horizon_seconds}-${prediction.outcome}`}>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "92px minmax(0, 1fr) 54px",
                          gap: 12,
                          alignItems: "center",
                        }}
                      >
                        <div className="eyebrow">+{prediction.horizon_seconds}s</div>
                        <div
                          style={{
                            height: 12,
                            borderRadius: 999,
                            background: "rgba(51, 65, 85, 0.6)",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.round(prediction.probability * 100)}%`,
                              height: "100%",
                              background:
                                severity === "S1"
                                  ? "#DC2626"
                                  : severity === "S2"
                                    ? "#EF4444"
                                    : "#14B8A6",
                            }}
                          />
                        </div>
                        <div
                          style={{
                            textAlign: "right",
                            fontFamily: "var(--font-mono)",
                            color: "var(--c-ink-secondary)",
                            fontSize: 12,
                          }}
                        >
                          {Math.round(prediction.probability * 100)}%
                        </div>
                      </div>
                      <div
                        style={{
                          marginTop: 8,
                          color: "var(--c-ink-secondary)",
                          fontSize: 13,
                        }}
                      >
                        {prediction.outcome}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Agent trace timeline" kicker={`${events.length} state transitions`}>
              {events.length === 0 ? (
                <EmptyState
                  title="Timeline waiting for event sync"
                  description="Once incident events land in Firestore, this panel becomes the readable trace for judges and operators."
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {events.map((event) => (
                    <div
                      key={event.event_id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "96px minmax(0, 1fr)",
                        gap: 14,
                        paddingBottom: 12,
                        borderBottom: "1px solid rgba(51, 65, 85, 0.5)",
                      }}
                    >
                      <div className="eyebrow" style={{ paddingTop: 2 }}>
                        {formatClock(event.event_time)}
                      </div>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 600 }}>
                          {event.from_status ?? "NEW"} → {event.to_status}
                        </div>
                        <div
                          style={{
                            marginTop: 4,
                            color: "var(--c-ink-secondary)",
                            fontSize: 13,
                          }}
                        >
                          {event.actor_type} · {event.actor_id}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <Panel
              title="Command actions"
              kicker={primary ? `Primary responder · ${primary.responder_id}` : "Awaiting dispatch"}
            >
              {actionError ? <Callout tone="#DC2626">{actionError}</Callout> : null}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 10,
                }}
              >
                <ActionButton
                  color={SEVERITY_COLOR[severity]}
                  disabled={!canAck || acting}
                  onClick={() => act("ack")}
                >
                  Claim
                </ActionButton>
                <ActionButton
                  color="transparent"
                  disabled={!canDecline || acting}
                  onClick={() => act("decline")}
                  outline
                >
                  Escalate
                </ActionButton>
                <ActionButton
                  color="transparent"
                  disabled={!canEnRoute || acting}
                  onClick={() => act("enroute")}
                  outline
                >
                  En route
                </ActionButton>
                <ActionButton
                  color="transparent"
                  disabled={!canArrive || acting}
                  onClick={() => act("arrived")}
                  outline
                >
                  Arrived
                </ActionButton>
                <ActionButton
                  color="transparent"
                  disabled={!canHandoff || acting}
                  onClick={() => act("handoff")}
                  outline
                >
                  Handoff
                </ActionButton>
              </div>
              <div
                style={{
                  marginTop: 14,
                  color: "var(--c-ink-secondary)",
                  fontSize: 13,
                }}
              >
                {primary
                  ? `${primary.role} ${primary.responder_id} currently sits in ${primary.status}.`
                  : "Dispatch service has not paged a responder for this incident yet."}
              </div>
            </Panel>

            <Panel title="Dispatch ladder" kicker={`${dispatches.length} dispatch records`}>
              {dispatches.length === 0 ? (
                <EmptyState
                  title="No dispatch records yet"
                  description="When responders are paged, this list shows who owns the incident and who is next in line."
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {dispatches.map((dispatch) => (
                    <div
                      key={dispatch.dispatch_id}
                      style={{
                        padding: 16,
                        borderRadius: 18,
                        background: "rgba(8, 15, 24, 0.72)",
                        border: "1px solid rgba(51, 65, 85, 0.92)",
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 12,
                          alignItems: "center",
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 16, fontWeight: 600 }}>
                            {dispatch.responder_id}
                          </div>
                          <div style={{ color: "var(--c-ink-muted)", fontSize: 13 }}>
                            {dispatch.role}
                          </div>
                        </div>
                        <DispatchBadge status={dispatch.status} />
                      </div>
                      <div style={{ color: "var(--c-ink-secondary)", fontSize: 13 }}>
                        {dispatch.notes || "No field note attached yet."}
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
                        <span>{dispatch.dispatch_id}</span>
                        <span>{isMounted ? formatSince(dispatch.arrived_at ?? dispatch.en_route_at ?? dispatch.acknowledged_at ?? dispatch.paged_at) : "..."}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Field playbook" kicker="Operator next steps">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {playbook.map((step, index) => (
                  <div
                    key={step}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "32px minmax(0, 1fr)",
                      gap: 12,
                      padding: 14,
                      borderRadius: 18,
                      background: "rgba(8, 15, 24, 0.72)",
                      border: "1px solid rgba(51, 65, 85, 0.92)",
                      alignItems: "start",
                    }}
                  >
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 999,
                        background: "rgba(20, 184, 166, 0.12)",
                        border: "1px solid rgba(20, 184, 166, 0.3)",
                        display: "grid",
                        placeItems: "center",
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        color: "var(--c-ink-secondary)",
                      }}
                    >
                      {index + 1}
                    </div>
                    <div style={{ color: "var(--c-ink-secondary)", fontSize: 13 }}>{step}</div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </div>
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
          <div className="eyebrow">{kicker ?? "Incident view"}</div>
          <h2 style={{ margin: "8px 0 0", fontSize: 24 }}>{title}</h2>
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
        marginBottom: 14,
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

function MetaChip({ label }: { label: string }) {
  return (
    <span
      style={{
        padding: "6px 10px",
        borderRadius: 999,
        background: "rgba(255, 255, 255, 0.04)",
        border: "1px solid rgba(51, 65, 85, 0.92)",
        fontSize: 12,
        color: "var(--c-ink-secondary)",
        fontFamily: "var(--font-mono)",
      }}
    >
      {label}
    </span>
  );
}

function SnapshotRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        alignItems: "center",
      }}
    >
      <span style={{ color: "var(--c-ink-secondary)", fontSize: 13 }}>{label}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{value}</span>
    </div>
  );
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

function ActionButton({
  children,
  color,
  disabled,
  onClick,
  outline,
}: {
  children: React.ReactNode;
  color: string;
  disabled: boolean;
  onClick: () => void;
  outline?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        minHeight: 52,
        padding: "14px 16px",
        borderRadius: 14,
        border: outline ? "1px solid rgba(51, 65, 85, 0.92)" : "none",
        background: outline ? "rgba(8, 15, 24, 0.72)" : color,
        color: outline ? "var(--c-ink-primary)" : "#F8FAFC",
        fontSize: 14,
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}

function buildPlaybook(incident: Incident | null): string[] {
  if (!incident) {
    return [
      "Watch for the first dispatch assignment, then claim or escalate it inside the 15 second window.",
      "Keep the evidence panel open so the team can align on the same visual truth.",
      "Log every override and handoff so the audit trace stays complete.",
    ];
  }

  const category = incident.classification?.category ?? "OTHER";
  const severity = incident.classification?.severity ?? "S4";

  const base = [
    "Confirm the primary responder owns the incident and route backup staff if the clock is still running.",
    "Keep adjacent zones clear until the cascade forecast flattens or the incident is downgraded.",
  ];

  if (category === "FIRE") {
    return [
      "Dispatch fire-trained staff first and keep the kitchen or source zone isolated from guest movement.",
      "Prepare guest evacuation messaging for adjacent zones before smoke spread accelerates.",
      ...base,
    ];
  }
  if (category === "MEDICAL") {
    return [
      "Page the nearest medically qualified responder and keep lift or corridor access clear.",
      "Gather any known patient context before external responders arrive for handoff.",
      ...base,
    ];
  }
  if (category === "STAMPEDE") {
    return [
      "Push staff to relieve the pressure edge immediately and open alternate circulation routes.",
      "Keep guest messaging calm, directional, and multilingual if the crowd is dense.",
      ...base,
    ];
  }
  if (severity === "S1") {
    return [
      "Treat this as an immediate safety event and keep a human operator in the loop on every side effect.",
      ...base,
      "Prepare authority contact details in case the escalation ladder reaches external services.",
    ];
  }
  return [
    "Validate the signal with nearby staff or cameras before broadening the response.",
    ...base,
    "If the incident downgrades, capture the rationale in the event trace for later review.",
  ];
}

function formatClock(value: unknown): string {
  return toDate(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatSince(value: unknown): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - toEpoch(value)) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  return `${Math.floor(elapsedSeconds / 3600)}h ago`;
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
