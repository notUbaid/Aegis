"use client";

import * as React from "react";
import {
  getDb,
  SEVERITY_COLOR,
  STATUS_COLOR,
  DISPATCH_STATUS_COLOR,
  type Dispatch,
  type DispatchStatus,
  type Incident,
  type IncidentStatus,
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
import Link from "next/link";
import { useRouter } from "next/navigation";
import { VENUE, SEV_LABEL, zoneById, responderById } from "@/lib/venue";
import { useUI } from "@/lib/ui";
import {
  acknowledgeIncident,
  dismissIncident,
  escalateIncident,
  checkAllHealth,
  runDrill,
  SERVICE_PORTS,
  type ServiceName,
  type DrillStep,
  seedDemoIncidents,
  checkDemoSeedingNeeded,
} from "@/lib/actions";
import { useAuth, doSignOut } from "@aegis/ui-web";

const DEFAULT_VENUE_ID = process.env.NEXT_PUBLIC_DEMO_VENUE_ID || "taj-ahmedabad";

type Tab = "live" | "history" | "setup" | "analytics";

const SEV_RANK: Record<Severity, number> = { S1: 0, S2: 1, S3: 2, S4: 3 };
const ACTIVE_DISPATCH: DispatchStatus[] = [
  "PAGED",
  "ACKNOWLEDGED",
  "EN_ROUTE",
  "ARRIVED",
  "HANDED_OFF",
];

const isActive = (i: Incident) => !["CLOSED", "DISMISSED"].includes(i.status);
const sevOf = (i: Incident): Severity => i.classification?.severity ?? "S4";
const catOf = (i: Incident) => i.classification?.category ?? "OTHER";

function elapsed(value: unknown): string {
  const ms = Math.max(0, Date.now() - toEpoch(value));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtClock(d: Date) {
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function toEpoch(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" || typeof v === "number") {
    const t = new Date(v).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (v && typeof v === "object" && "toDate" in v && typeof (v as { toDate?: unknown }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate().getTime();
  }
  if (v && typeof v === "object" && "seconds" in v && typeof (v as { seconds?: unknown }).seconds === "number") {
    const s = (v as { seconds: number }).seconds;
    return s * 1000;
  }
  return Date.now();
}

export default function ControlRoom() {
  const { user, loading: authLoading } = useAuth();
  const [incidents, setIncidents] = React.useState<Incident[]>([]);
  const [dispatches, setDispatches] = React.useState<Dispatch[]>([]);
  const [venueId, setVenueId] = React.useState<string>(DEFAULT_VENUE_ID);
  const [tab, setTab] = React.useState<Tab>("live");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [now, setNow] = React.useState<Date | null>(null);
  const [health, setHealth] = React.useState<Record<ServiceName, boolean> | null>(null);
  const [drillOpen, setDrillOpen] = React.useState(false);
  const ui = useUI();

  // ── Auth guard (redirect) ───────────────────────────────────────────────
  const router = useRouter();
  React.useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [user, authLoading, router]);

  React.useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  React.useEffect(() => {
    let active = true;
    const ping = async () => {
      const next = await checkAllHealth();
      if (active) setHealth(next);
    };
    void ping();
    const t = setInterval(ping, 10000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  React.useEffect(() => {
    if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) {
      setError("Firebase not configured. Set NEXT_PUBLIC_FIREBASE_* for the dashboard.");
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
        (snap) => setIncidents(snap.docs.map((d) => d.data() as Incident)),
        (err) => setError(err.message),
      );
      return () => unsub();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [venueId]);

  const activeIncidentKey = incidents
    .filter(isActive)
    .slice(0, 6)
    .map((i) => i.incident_id)
    .join("|");

  React.useEffect(() => {
    if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) return;
    const ids = activeIncidentKey ? activeIncidentKey.split("|").filter(Boolean) : [];
    if (!ids.length) {
      setDispatches([]);
      return;
    }
    const db = getDb();
    const cache = new Map<string, Dispatch[]>();
    const publish = () => {
      const merged = Array.from(cache.values())
        .flat()
        .sort((a, b) => toEpoch(b.paged_at) - toEpoch(a.paged_at));
      setDispatches(merged);
    };
    const unsubs = ids.map((id) =>
      onSnapshot(
        query(collection(db, "incidents", id, "dispatches"), orderBy("paged_at", "desc")),
        (snap) => {
          cache.set(id, snap.docs.map((d) => d.data() as Dispatch));
          publish();
        },
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [activeIncidentKey]);

  const active = React.useMemo(
    () =>
      incidents
        .filter(isActive)
        .sort((a, b) => SEV_RANK[sevOf(a)] - SEV_RANK[sevOf(b)]),
    [incidents],
  );
  const recent = React.useMemo(() => incidents.filter((i) => !isActive(i)), [incidents]);
  const criticalInc = active.find((i) => sevOf(i) === "S1");
  const criticalCount = active.filter((i) => sevOf(i) === "S1").length;
  const venueState: "Critical" | "Elevated" | "Nominal" =
    criticalCount > 0 ? "Critical" : active.length > 0 ? "Elevated" : "Nominal";
  const activeDispatches = dispatches.filter(
    (d) => !["DECLINED", "TIMED_OUT"].includes(d.status),
  );

  // Auto-select critical incident
  React.useEffect(() => {
    if (!selectedId && criticalInc) setSelectedId(criticalInc.incident_id);
  }, [criticalInc, selectedId]);

  const selectedInc = incidents.find((i) => i.incident_id === selectedId) ?? null;

  function openIncident(id: string) {
    window.location.href = `/incident/${id}`;
  }

  // ── Auth guard (blank screen while redirecting) ─────────────────────────
  if (authLoading || !user) {
    return <div style={{ minHeight: "100vh", background: "var(--c-bg-primary)" }} />;
  }

  async function handleAction(action: "ack" | "escalate" | "dismiss", incident: Incident) {
    try {
      if (action === "escalate") {
        const ok = await ui.confirm({
          title: "Escalate to authorities?",
          message: "Notifies emergency services and creates an authority packet.",
          tone: "warn",
          confirmLabel: "Escalate",
          eyebrow: "Confirm escalation",
        });
        if (!ok) return;
        const services = [
          VENUE.nearby_services.ambulance[0]?.name,
          VENUE.nearby_services.fire[0]?.name,
          VENUE.nearby_services.police[0]?.name,
        ].filter(Boolean) as string[];
        await escalateIncident(incident, services);
        ui.toast("Authority packet dispatched · audit-signed", { tone: "warn", title: "Escalated" });
      } else if (action === "dismiss") {
        const ok = await ui.confirm({
          title: "Dismiss incident?",
          message: "Mark this as a false positive. Audit trail preserved.",
          tone: "danger",
          confirmLabel: "Dismiss",
        });
        if (!ok) return;
        await dismissIncident(incident);
        ui.toast(`${incident.incident_id} dismissed`, { tone: "info" });
      } else {
        await acknowledgeIncident(incident);
        ui.toast("Acknowledged", { tone: "success" });
      }
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), {
        tone: "danger",
        title: "Action failed",
      });
    }
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      <TopBar
        venueState={venueState}
        criticalCount={criticalCount}
        cameraOpen={cameraOpen}
        setCameraOpen={setCameraOpen}
        tab={tab}
        setTab={setTab}
        venueId={venueId}
        setVenueId={setVenueId}
        now={now}
        health={health}
        onDrill={() => setDrillOpen(true)}
        userName={user?.displayName ?? null}
        userEmail={user?.email ?? null}
      />
      {drillOpen ? (
        <DrillModal
          venueId={venueId}
          onClose={() => setDrillOpen(false)}
        />
      ) : null}
      <div className="scroll" style={{ flex: 1, overflowY: "auto", position: "relative" }}>
        {tab === "live" && (
          <>
            {error ? (
              <div style={{ margin: "16px 20px 0", padding: 14, background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.4)", borderRadius: 14, fontSize: 13, color: "#94a3b8" }}>
                <span style={{ fontFamily: "var(--font-mono)", color: "#f59e0b", fontSize: 11, letterSpacing: "0.1em" }}>
                  OFFLINE MODE ·{" "}
                </span>
                {error}
              </div>
            ) : null}
            {criticalInc ? (
              <CriticalHero
                incident={criticalInc}
                onView={() => openIncident(criticalInc.incident_id)}
                onAck={() => handleAction("ack", criticalInc)}
                onEscalate={() => handleAction("escalate", criticalInc)}
              />
            ) : null}
            <MetricsRow active={active} dispatches={activeDispatches} />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: cameraOpen ? "1fr 360px" : "1.1fr 0.9fr",
                gap: 12,
                padding: "12px 20px 20px",
                minHeight: 0,
                transition: "grid-template-columns 0.2s ease",
              }}
            >
              <IncidentFeed
                active={active}
                recent={recent}
                selectedId={selectedId}
                setSelected={setSelectedId}
                openIncident={openIncident}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
                <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
                  <IncidentDetailPanel
                    incident={selectedInc}
                    dispatches={dispatches}
                    onAction={handleAction}
                    openIncident={openIncident}
                  />
                </div>
                <div style={{ flex: "0 0 auto" }}>
                  <ResponderBoard
                    dispatches={activeDispatches}
                    incidents={incidents}
                    openIncident={openIncident}
                  />
                </div>
              </div>
            </div>
          </>
        )}
        {tab === "history" ? <HistoryTab incidents={incidents} /> : null}
        {tab === "setup" ? <SetupTab /> : null}
        {tab === "analytics" ? <AnalyticsTab incidents={incidents} /> : null}
      </div>
      
    </div>
  );
}

// ── Profile Menu ───────────────────────────────────────────────────────────
function ProfileMenu({ userName, userEmail }: { userName: string | null; userEmail: string | null }) {
  const initial = (userName ?? userEmail ?? "?")[0]?.toUpperCase() ?? "?";
  const [open, setOpen] = React.useState(false);
  const [theme, setTheme] = React.useState<"dark" | "light">("dark");
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const stored = localStorage.getItem("aegis-theme") as "dark" | "light" | null;
    if (stored === "light" || stored === "dark") setTheme(stored);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next === "light" ? "light" : "");
    localStorage.setItem("aegis-theme", next);
  }

  async function handleSignOut() {
    setOpen(false);
    await doSignOut();
  }

  const isDark = theme === "dark";

  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Profile menu"
        style={{
          width: 28,
          height: 28,
          borderRadius: 999,
          background: open ? "rgba(20,184,166,0.15)" : "var(--c-bg-surface)",
          border: `1px solid ${open ? "rgba(20,184,166,0.5)" : "var(--c-border-strong)"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 600,
          color: open ? "#14b8a6" : "var(--c-ink-secondary)",
          cursor: "pointer",
          transition: "all 140ms ease",
          flexShrink: 0,
        }}
      >
        {initial}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: 36,
            right: 0,
            width: 224,
            background: "var(--c-bg-elevated)",
            border: "1px solid var(--c-border-strong)",
            borderRadius: 14,
            boxShadow: "0 20px 60px rgba(2,6,23,0.5), 0 4px 16px rgba(2,6,23,0.3)",
            overflow: "hidden",
            zIndex: 200,
          }}
        >
          {/* User header */}
          <div style={{ padding: "14px 16px 12px", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 34,
              height: 34,
              borderRadius: 999,
              background: "rgba(20,184,166,0.13)",
              border: "1px solid rgba(20,184,166,0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              fontWeight: 700,
              color: "#14b8a6",
              flexShrink: 0,
            }}>
              {initial}
            </div>
            <div style={{ minWidth: 0 }}>
              {userName && (
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-ink-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {userName}
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--c-ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {userEmail ?? "—"}
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: "var(--c-border)" }} />

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 16px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--c-ink-secondary)",
              fontSize: 13,
              fontFamily: "inherit",
              textAlign: "left",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(148,163,184,0.08)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            {isDark ? (
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <circle cx={12} cy={12} r={5} />
                <line x1={12} y1={1} x2={12} y2={3} /><line x1={12} y1={21} x2={12} y2={23} />
                <line x1={4.22} y1={4.22} x2={5.64} y2={5.64} /><line x1={18.36} y1={18.36} x2={19.78} y2={19.78} />
                <line x1={1} y1={12} x2={3} y2={12} /><line x1={21} y1={12} x2={23} y2={12} />
                <line x1={4.22} y1={19.78} x2={5.64} y2={18.36} /><line x1={18.36} y1={5.64} x2={19.78} y2={4.22} />
              </svg>
            ) : (
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
            <span>{isDark ? "Light mode" : "Dark mode"}</span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--c-ink-muted)", background: "var(--c-bg-surface)", borderRadius: 4, padding: "1px 5px" }}>
              {isDark ? "DARK" : "LIGHT"}
            </span>
          </button>

          <div style={{ height: 1, background: "var(--c-border)" }} />

          {/* Sign out */}
          <button
            onClick={() => void handleSignOut()}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 16px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "#ef4444",
              fontSize: 13,
              fontFamily: "inherit",
              textAlign: "left",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1={21} y1={12} x2={9} y2={12} />
            </svg>
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ── Top Bar ────────────────────────────────────────────────────────────────
function TopBar({
  venueState,
  criticalCount,
  cameraOpen,
  setCameraOpen,
  tab,
  setTab,
  venueId,
  setVenueId,
  now,
  health,
  onDrill,
  userName,
  userEmail,
}: {
  venueState: "Critical" | "Elevated" | "Nominal";
  criticalCount: number;
  cameraOpen: boolean;
  setCameraOpen: (fn: (o: boolean) => boolean) => void;
  tab: Tab;
  setTab: (t: Tab) => void;
  venueId: string;
  setVenueId: (id: string) => void;
  now: Date | null;
  health: Record<ServiceName, boolean> | null;
  onDrill: () => void;
  userName: string | null;
  userEmail: string | null;
}) {
  const stateColor =
    venueState === "Critical" ? "#dc2626" : venueState === "Elevated" ? "#f59e0b" : "#10b981";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 20px",
        height: 52,
        borderBottom: "1px solid rgba(51,65,85,0.5)",
        flexShrink: 0,
        background: "var(--c-topbar-bg)",
        backdropFilter: "blur(12px)",
        zIndex: 10,
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginRight: 8 }}>
        <svg width={18} height={24} viewBox="0 0 28 40" fill="none">
          <path d="M4 4H10V2H18V4H24V22C24 30 14 36 14 36C14 36 4 30 4 22V4Z" stroke="#14b8a6" strokeWidth={1.5} />
          <path d="M14 10V28M9 18H19" stroke="#14b8a6" strokeWidth={1.2} opacity={0.55} />
        </svg>
        <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: "0.02em" }}>AEGIS</span>
      </div>
      <div style={{ height: 18, width: 1, background: "var(--c-border-strong)" }} />
      <select
        value={venueId}
        onChange={(e) => setVenueId(e.target.value)}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--c-ink-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          padding: "0 4px",
          width: "auto",
        }}
      >
        <option value="taj-ahmedabad">taj-ahmedabad</option>
        <option value="house-of-mg">house-of-mg</option>
        <option value="demo-venue">demo-venue</option>
      </select>
      <div style={{ height: 18, width: 1, background: "var(--c-border-strong)" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: stateColor,
            animation: venueState === "Critical" ? "aegis-dot-pulse 1.4s infinite" : "none",
            boxShadow: `0 0 8px ${stateColor}88`,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 500, color: stateColor }}>{venueState}</span>
        {criticalCount > 0 ? (
          <span
            style={{
              background: "rgba(220,38,38,0.2)",
              border: "1px solid rgba(220,38,38,0.4)",
              borderRadius: 999,
              padding: "1px 7px",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: "#dc2626",
            }}
          >
            {criticalCount} S1
          </span>
        ) : null}
      </div>
      <div style={{ height: 18, width: 1, background: "var(--c-border-strong)", marginLeft: 10 }} />
      <div style={{ display: "flex", gap: 4 }}>
        {(["live", "history", "setup", "analytics"] as Tab[]).map((t) => (
          <TabBtn key={t} active={tab === t} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </TabBtn>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--c-ink-muted)", letterSpacing: "0.05em" }}>
        {now ? fmtClock(now) : "--:--:--"}
      </span>
      <ServiceHealthPills health={health} />
      <a
        href={process.env.NEXT_PUBLIC_STAFF_URL || "http://localhost:3001"}
        target="_blank"
        rel="noreferrer"
        style={btnGhostStyle({ fontSize: 11, padding: "5px 12px", textDecoration: "none" })}
      >
        Staff app
      </a>
      <button
        onClick={() => setCameraOpen((o) => !o)}
        style={cameraOpen ? btnTealStyle({ fontSize: 11, padding: "5px 12px" }) : btnGhostStyle({ fontSize: 11, padding: "5px 12px" })}
      >
        Cameras
      </button>
      <button onClick={onDrill} style={btnTealStyle({ fontSize: 11, padding: "5px 12px" })}>
        Run drill
      </button>
      <ProfileMenu userName={userName} userEmail={userEmail} />
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 12px",
        borderRadius: 8,
        fontSize: 12,
        fontWeight: 500,
        background: active ? "rgba(20,184,166,0.10)" : "transparent",
        color: active ? "#14b8a6" : "var(--c-ink-muted)",
        border: active ? "1px solid rgba(20,184,166,0.3)" : "1px solid transparent",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

// ── Critical Hero ─────────────────────────────────────────────────────────
function CriticalHero({
  incident,
  onView,
  onAck,
  onEscalate,
}: {
  incident: Incident;
  onView: () => void;
  onAck: () => void;
  onEscalate: () => void;
}) {
  const sev = sevOf(incident);
  const cat = catOf(incident);
  const preds = incident.classification?.cascade_predictions ?? [];
  return (
    <div
      style={{
        margin: "16px 20px 0",
        background: "linear-gradient(135deg, rgba(220,38,38,0.09) 0%, rgba(18,24,33,0.9) 60%)",
        border: "1px solid rgba(220,38,38,0.45)",
        borderRadius: 20,
        padding: "18px 22px",
        animation: "aegis-glow-pulse 2.5s ease-in-out infinite, aegis-fade-up 0.22s ease-out both",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 280, cursor: "pointer" }} onClick={onView}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#dc2626",
                animation: "aegis-dot-pulse 1.2s infinite",
                boxShadow: "0 0 10px rgba(220,38,38,0.8)",
              }}
            />
            <Eyebrow style={{ color: "rgba(220,38,38,0.8)" }}>Critical · {incident.incident_id}</Eyebrow>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <SevBadge sev={sev} large />
            <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.15, margin: 0 }}>
              {cat}
              {incident.classification?.sub_type ? (
                <span style={{ color: "var(--c-ink-secondary)", fontWeight: 400 }}>
                  {" "}· {incident.classification.sub_type}
                </span>
              ) : null}
            </h2>
          </div>
          <p style={{ fontSize: 13, color: "var(--c-ink-secondary)", lineHeight: 1.55, marginBottom: 10, maxWidth: 560 }}>
            {incident.summary}
          </p>
          <div style={{ display: "flex", gap: 16, fontSize: 12, flexWrap: "wrap" }}>
            <Mono>Zone · <span style={{ color: "var(--c-ink-secondary)" }}>{zoneById(incident.zone_id).name}</span></Mono>
            <Mono>Detected · <span style={{ color: "var(--c-ink-secondary)" }}>{elapsed(incident.detected_at)} ago</span></Mono>
            <Mono>Confidence · <span style={{ color: "#f59e0b" }}>{Math.round((incident.classification?.confidence ?? 0) * 100)}%</span></Mono>
          </div>
        </div>
        {preds.length > 0 ? (
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            {preds.map((p, i) => (
              <div
                key={i}
                style={{
                  background: "rgba(220,38,38,0.08)",
                  border: "1px solid rgba(220,38,38,0.2)",
                  borderRadius: 12,
                  padding: "10px 14px",
                  minWidth: 130,
                }}
              >
                <Eyebrow style={{ color: "rgba(220,38,38,0.65)", marginBottom: 4 }}>
                  In {Math.round(p.horizon_seconds / 60)}m
                </Eyebrow>
                <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 3 }}>{p.outcome}</div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 13,
                    fontWeight: 600,
                    color: p.probability > 0.6 ? "#dc2626" : "#f59e0b",
                  }}
                >
                  {Math.round(p.probability * 100)}%
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
          <button onClick={onView} style={btnTealStyle()}>View incident</button>
          <button onClick={onEscalate} style={btnWarnStyle()}>Escalate</button>
          <button onClick={onAck} style={btnGhostStyle()}>Acknowledge</button>
        </div>
      </div>
    </div>
  );
}

// ── Metrics Row ───────────────────────────────────────────────────────────
function MetricsRow({ active, dispatches }: { active: Incident[]; dispatches: Dispatch[] }) {
  const critCount = active.filter((i) => sevOf(i) === "S1").length;
  const ownedCount = dispatches.filter((d) => ACTIVE_DISPATCH.includes(d.status)).length;
  const avgAge = active.length
    ? Math.round(
        active.reduce((s, i) => s + (Date.now() - toEpoch(i.detected_at)) / 60000, 0) / active.length,
      )
    : 0;
  const tiles = [
    { label: "Live incidents", value: String(active.length), accent: "#14b8a6", sub: "Realtime" },
    { label: "S1 pressure", value: String(critCount), accent: "#dc2626", sub: "Critical" },
    { label: "Responders moving", value: String(ownedCount), accent: "#f59e0b", sub: "Acknowledged + en route" },
    {
      label: "Avg incident age",
      value: active.length ? `${avgAge}m` : "—",
      accent: "#3b82f6",
      sub: "Minutes open",
    },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, padding: "12px 20px 0" }}>
      {tiles.map((t) => (
        <div
          key={t.label}
          style={{
            background: "rgba(18,24,33,0.7)",
            border: "1px solid rgba(51,65,85,0.7)",
            borderRadius: 12,
            padding: "14px 16px",
          }}
        >
          <div
            style={{
              fontSize: 26,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              color: t.accent,
              lineHeight: 1,
              letterSpacing: "-0.02em",
            }}
          >
            {t.value}
          </div>
          <div style={{ fontSize: 12, fontWeight: 500, marginTop: 5 }}>{t.label}</div>
          <Eyebrow style={{ marginTop: 3 }}>{t.sub}</Eyebrow>
        </div>
      ))}
    </div>
  );
}

// ── Incident Row + Feed ───────────────────────────────────────────────────
function IncidentRow({
  incident,
  selected,
  onClick,
  onOpen,
}: {
  incident: Incident;
  selected: boolean;
  onClick: () => void;
  onOpen: () => void;
}) {
  const sev = sevOf(incident);
  const cat = catOf(incident);
  const sevColor = SEVERITY_COLOR[sev];
  const closed = ["CLOSED", "DISMISSED"].includes(incident.status);
  return (
    <div
      onClick={onClick}
      onDoubleClick={onOpen}
      className="hover-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "11px 16px",
        borderRadius: 10,
        background: selected ? "rgba(20,184,166,0.06)" : "transparent",
        border: selected ? "1px solid rgba(20,184,166,0.25)" : "1px solid transparent",
        opacity: closed ? 0.55 : 1,
        cursor: "pointer",
      }}
    >
      <div style={{ width: 3, height: 36, borderRadius: 2, background: sevColor, opacity: closed ? 0.4 : 1, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: closed ? "var(--c-ink-muted)" : "var(--c-ink-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {cat}
            {incident.classification?.sub_type ? ` · ${incident.classification.sub_type}` : ""}
          </span>
          <SevBadge sev={sev} />
        </div>
        <div style={{ display: "flex", gap: 10, fontSize: 11, color: "var(--c-ink-muted)" }}>
          <span style={{ fontFamily: "var(--font-mono)" }}>{incident.incident_id}</span>
          <span>{zoneById(incident.zone_id).name}</span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5, flexShrink: 0 }}>
        <StatusDot status={incident.status} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--c-ink-muted)" }}>
          {elapsed(incident.detected_at)}
        </span>
      </div>
    </div>
  );
}

function IncidentFeed({
  active,
  recent,
  selectedId,
  setSelected,
  openIncident,
}: {
  active: Incident[];
  recent: Incident[];
  selectedId: string | null;
  setSelected: (id: string) => void;
  openIncident: (id: string) => void;
}) {
  const [filter, setFilter] = React.useState<"all" | Severity>("all");
  const visible = filter === "all" ? active : active.filter((i) => sevOf(i) === filter);
  const ui = useUI();
  return (
    <div className="glass" style={glassStyle({ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 })}>
      <div style={{ padding: "14px 18px 12px", borderBottom: "1px solid rgba(51,65,85,0.5)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div>
            <Eyebrow style={{ marginBottom: 3 }}>Incident feed</Eyebrow>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{visible.length} active</div>
          </div>
          <Link
            href="/drill"
            onClick={() => ui.toast("Opening drill console", { tone: "info" })}
            style={btnGhostStyle({ fontSize: 11, padding: "4px 10px", textDecoration: "none" })}
          >
            Launch drill
          </Link>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["all", "S1", "S2", "S3", "S4"] as const).map((f) => (
            <TabBtn key={f} active={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f}
            </TabBtn>
          ))}
        </div>
      </div>
      <div className="scroll" style={{ flex: 1, padding: "8px 10px", overflowY: "auto" }}>
        {visible.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "var(--c-ink-muted)" }}>No active incidents</div>
            <Eyebrow style={{ marginTop: 4 }}>Venue nominal</Eyebrow>
          </div>
        ) : (
          visible.map((inc) => (
            <IncidentRow
              key={inc.incident_id}
              incident={inc}
              selected={selectedId === inc.incident_id}
              onClick={() => setSelected(inc.incident_id)}
              onOpen={() => openIncident(inc.incident_id)}
            />
          ))
        )}
        {recent.length > 0 ? (
          <>
            <div style={{ padding: "12px 16px 6px" }}>
              <Eyebrow>Recent closures</Eyebrow>
            </div>
            {recent.slice(0, 4).map((inc) => (
              <IncidentRow
                key={inc.incident_id}
                incident={inc}
                selected={selectedId === inc.incident_id}
                onClick={() => setSelected(inc.incident_id)}
                onOpen={() => openIncident(inc.incident_id)}
              />
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Detail Panel ──────────────────────────────────────────────────────────
function IncidentDetailPanel({
  incident,
  dispatches,
  onAction,
  openIncident,
}: {
  incident: Incident | null;
  dispatches: Dispatch[];
  onAction: (action: "ack" | "escalate" | "dismiss", incident: Incident) => void;
  openIncident: (id: string) => void;
}) {
  if (!incident) {
    return (
      <div
        className="glass"
        style={glassStyle({
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--c-ink-muted)",
          fontSize: 13,
          padding: 32,
          flexDirection: "column",
          gap: 8,
          minHeight: 280,
        })}
      >
        <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.2} opacity={0.4}>
          <circle cx={12} cy={12} r={10} />
          <path d="M12 8v4m0 4h.01" />
        </svg>
        Click an incident to see details
      </div>
    );
  }
  const sev = sevOf(incident);
  const myDispatches = dispatches.filter((d) => d.incident_id === incident.incident_id);
  const closed = ["CLOSED", "DISMISSED"].includes(incident.status);
  const conf = Math.round((incident.classification?.confidence ?? 0) * 100);
  return (
    <div
      className="glass"
      style={{
        ...glassStyle({ display: "flex", flexDirection: "column", overflow: "hidden" }),
        animation: "aegis-slide-in 0.22s ease-out both",
      }}
    >
      <div style={{ padding: "14px 18px 12px", borderBottom: "1px solid rgba(51,65,85,0.5)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <Eyebrow>{incident.incident_id}</Eyebrow>
          <SevBadge sev={sev} />
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}>
          {incident.classification?.category}
          {incident.classification?.sub_type ? (
            <span style={{ color: "var(--c-ink-secondary)", fontWeight: 400 }}>
              {" "}· {incident.classification.sub_type}
            </span>
          ) : null}
        </div>
      </div>
      <div className="scroll" style={{ flex: 1, padding: "14px 18px", overflowY: "auto" }}>
        <p style={{ fontSize: 13, color: "var(--c-ink-secondary)", lineHeight: 1.6, marginBottom: 12 }}>{incident.summary}</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          {[
            ["Zone", zoneById(incident.zone_id).name],
            ["Status", incident.status.replace("_", " ")],
            ["Detected", `${elapsed(incident.detected_at)} ago`],
            ["AI conf", `${conf}%`],
          ].map(([l, v]) => (
            <div key={l} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 8, padding: "7px 11px" }}>
              <Eyebrow style={{ marginBottom: 2 }}>{l}</Eyebrow>
              <div style={{ fontSize: 12, fontWeight: 500 }}>{v}</div>
            </div>
          ))}
        </div>

        {myDispatches.length > 0 ? (
          <>
            <Eyebrow style={{ marginBottom: 8 }}>Responders</Eyebrow>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {myDispatches.map((d) => {
                const color = DISPATCH_STATUS_COLOR[d.status];
                const r = responderById(d.responder_id);
                return (
                  <div
                    key={d.dispatch_id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      background: "rgba(255,255,255,0.02)",
                      borderRadius: 8,
                      padding: "9px 12px",
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{r?.display_name ?? d.responder_id}</div>
                      <div style={{ fontSize: 11, color: "var(--c-ink-muted)", marginTop: 1 }}>
                        {d.notes || d.role}
                      </div>
                    </div>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        color,
                        padding: "2px 7px",
                        background: `${color}18`,
                        borderRadius: 999,
                        border: `1px solid ${color}44`,
                      }}
                    >
                      {d.status.replace("_", " ")}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}

        {(incident.classification?.cascade_predictions ?? []).length > 0 ? (
          <>
            <Eyebrow style={{ marginBottom: 8 }}>Cascade predictions</Eyebrow>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {incident.classification!.cascade_predictions.map((p, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    background: "rgba(220,38,38,0.05)",
                    borderRadius: 8,
                    padding: "9px 12px",
                    border: "1px solid rgba(220,38,38,0.12)",
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12 }}>{p.outcome}</div>
                    <Eyebrow style={{ marginTop: 2 }}>In {Math.round(p.horizon_seconds / 60)} min</Eyebrow>
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 15,
                      fontWeight: 600,
                      color: p.probability > 0.6 ? "#dc2626" : "#f59e0b",
                    }}
                  >
                    {Math.round(p.probability * 100)}%
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div style={{ padding: "10px 14px", borderTop: "1px solid rgba(51,65,85,0.5)", display: "flex", gap: 6, flexShrink: 0 }}>
        <button onClick={() => openIncident(incident.incident_id)} style={btnTealStyle({ flex: 1 })}>
          Open full view
        </button>
        {!closed ? (
          <>
            <button onClick={() => onAction("escalate", incident)} style={btnWarnStyle()}>
              Escalate
            </button>
            <button onClick={() => onAction("dismiss", incident)} style={btnGhostStyle()}>
              Dismiss
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Responder Board ───────────────────────────────────────────────────────
function ResponderBoard({
  dispatches,
  incidents,
  openIncident,
}: {
  dispatches: Dispatch[];
  incidents: Incident[];
  openIncident: (id: string) => void;
}) {
  return (
    <div
      className="glass"
      style={glassStyle({ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 200 })}
    >
      <div style={{ padding: "14px 18px 12px", borderBottom: "1px solid rgba(51,65,85,0.5)", flexShrink: 0 }}>
        <Eyebrow style={{ marginBottom: 3 }}>Responders</Eyebrow>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{dispatches.length} active dispatches</div>
      </div>
      <div className="scroll" style={{ flex: 1, padding: "6px 12px", overflowY: "auto" }}>
        {dispatches.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--c-ink-muted)", fontSize: 12 }}>
            No active dispatches
          </div>
        ) : (
          dispatches.map((d) => {
            const color = DISPATCH_STATUS_COLOR[d.status];
            const inc = incidents.find((i) => i.incident_id === d.incident_id);
            const r = responderById(d.responder_id);
            const initials = (r?.display_name ?? d.responder_id)
              .split(" ")
              .map((s) => s[0])
              .join("")
              .slice(0, 2)
              .toUpperCase();
            return (
              <div
                key={d.dispatch_id}
                onClick={() => inc && openIncident(inc.incident_id)}
                className="hover-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 8px",
                  borderRadius: 8,
                  borderBottom: "1px solid rgba(51,65,85,0.25)",
                  cursor: "pointer",
                }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: "var(--c-bg-surface)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--c-ink-secondary)",
                    flexShrink: 0,
                  }}
                >
                  {initials}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{r?.display_name ?? d.responder_id}</div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--c-ink-muted)",
                      marginTop: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {d.role} · {inc ? zoneById(inc.zone_id).name : d.incident_id}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      color,
                      padding: "2px 6px",
                      background: `${color}15`,
                      borderRadius: 999,
                      border: `1px solid ${color}40`,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {d.status.replace("_", " ")}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--c-ink-muted)" }}>
                    {elapsed(d.paged_at)}
                  </span>
                </div>
              </div>
            );
          })
        )}
       </div>
     </div>
   );
 }

// ── History Tab ───────────────────────────────────────────────────────────
function HistoryTab({ incidents }: { incidents: Incident[] }) {
  const all = [...incidents].sort((a, b) => toEpoch(b.detected_at) - toEpoch(a.detected_at));
  const counts = {
    total: all.length,
    closed: all.filter((i) => i.status === "CLOSED").length,
    dismissed: all.filter((i) => i.status === "DISMISSED").length,
    open: all.filter(isActive).length,
  };
  const tiles: [string, number, string][] = [
    ["Tracked", counts.total, "#3b82f6"],
    ["Resolved", counts.closed, "#10b981"],
    ["Dismissed", counts.dismissed, "#64748b"],
    ["Open", counts.open, "#f59e0b"],
  ];
  return (
    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
        {tiles.map(([l, v, c]) => (
          <div
            key={l}
            style={{
              background: "rgba(18,24,33,0.7)",
              border: "1px solid rgba(51,65,85,0.7)",
              borderRadius: 12,
              padding: "14px 16px",
            }}
          >
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "var(--font-mono)", color: c }}>{v}</div>
            <div style={{ fontSize: 12, marginTop: 5 }}>{l}</div>
          </div>
        ))}
      </div>
      <div className="glass" style={glassStyle()}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(51,65,85,0.5)" }}>
          <Eyebrow>Incident log · latest first</Eyebrow>
        </div>
        <div className="scroll" style={{ padding: 8, maxHeight: "60vh", overflowY: "auto" }}>
          {all.map((inc) => (
            <Link
              key={inc.incident_id}
              href={`/incident/${inc.incident_id}`}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <IncidentRow incident={inc} selected={false} onClick={() => {}} onOpen={() => {}} />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Setup Tab ─────────────────────────────────────────────────────────────
function SetupTab() {
  const ui = useUI();
  const venueId = DEFAULT_VENUE_ID;
  const [seeding, setSeeding] = React.useState(false);
  const [seedNeeded, setSeedNeeded] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    checkDemoSeedingNeeded(venueId).then(setSeedNeeded);
  }, [venueId]);

  async function handleSeed() {
    setSeeding(true);
    try {
      const { seeded } = await seedDemoIncidents(venueId);
      ui.toast(`Seeded ${seeded} demo incidents`, { tone: "success" });
      setSeedNeeded(false);
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), { tone: "danger" });
    } finally {
      setSeeding(false);
    }
  }

  return (
    <div style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16 }}>
      <div className="glass" style={glassStyle({ padding: 20 })}>
        <Eyebrow>Venue profile</Eyebrow>
        <h3 style={{ fontSize: 18, fontWeight: 600, marginTop: 6, marginBottom: 14 }}>{VENUE.name}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 13 }}>
          <Field label="Address" value={VENUE.address} />
          <Field label="Timezone" value={VENUE.timezone} />
          <Field label="Floor area" value={`${VENUE.size_sqm.toLocaleString()} m²`} />
          <Field label="Max occupancy" value={String(VENUE.max_occupancy)} />
          <Field label="Languages" value={VENUE.languages.join(", ")} />
          <Field label="Geo" value={`${VENUE.geo.lat}, ${VENUE.geo.lng}`} />
        </div>
        <div style={{ marginTop: 18 }}>
          <Eyebrow style={{ marginBottom: 8 }}>Zones ({VENUE.zones.length})</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {VENUE.zones.map((z) => (
              <div
                key={z.zone_id}
                className="hover-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "9px 12px",
                  background: "rgba(255,255,255,0.02)",
                  borderRadius: 8,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{z.name}</div>
                  <div style={{ fontSize: 11, color: "var(--c-ink-muted)", fontFamily: "var(--font-mono)" }}>
                    {z.zone_id} · floor {z.floor} · cap {z.capacity}
                  </div>
                </div>
                <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--c-ink-muted)" }}>
                  {z.camera_ids.length} cams · {z.sensor_ids.length} sensors
                </span>
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "rgba(20,184,166,0.1)",
                    color: "#14b8a6",
                    border: "1px solid rgba(20,184,166,0.25)",
                  }}
                >
                  {z.exit_count} exits
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="glass" style={glassStyle({ padding: 20 })}>
          <Eyebrow>Roster ({VENUE.responders.length})</Eyebrow>
          <h3 style={{ fontSize: 18, fontWeight: 600, marginTop: 6, marginBottom: 14 }}>On-shift responders</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {VENUE.responders.map((r) => {
              const initials = r.display_name.split(" ").map((s) => s[0]).join("").slice(0, 2);
              return (
                <div
                  key={r.responder_id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    background: "rgba(255,255,255,0.02)",
                    borderRadius: 10,
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      background: "var(--c-bg-surface)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 600,
                      color: "#14b8a6",
                    }}
                  >
                    {initials}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{r.display_name}</div>
                    <div style={{ fontSize: 11, color: "var(--c-ink-muted)" }}>
                      {r.role} · {r.languages.join("/")}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                    <span
                      style={{
                        fontSize: 9,
                        color: r.on_shift ? "#10b981" : "var(--c-ink-muted)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      ● {r.on_shift ? "ON SHIFT" : "OFF"}
                    </span>
                    <span style={{ fontSize: 9, color: "var(--c-ink-muted)", fontFamily: "var(--font-mono)" }}>
                      {r.skills.length} skills
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 16,
              padding: 14,
              background: "rgba(20,184,166,0.06)",
              borderRadius: 12,
              border: "1px solid rgba(20,184,166,0.2)",
            }}
          >
            <Eyebrow style={{ color: "#14b8a6" }}>Nearby services</Eyebrow>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8, fontSize: 12 }}>
              {[
                ...VENUE.nearby_services.ambulance,
                ...VENUE.nearby_services.fire,
                ...VENUE.nearby_services.police,
              ].map((s, i) => (
                <div
                  key={i}
                  style={{ display: "flex", justifyContent: "space-between", color: "var(--c-ink-secondary)" }}
                >
                  <span>{s.name}</span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--c-ink-muted)" }}>
                    {s.phone} · {s.distance_km}km
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="glass" style={glassStyle({ padding: 20 })}>
          <Eyebrow>Demo mode</Eyebrow>
          <h3 style={{ fontSize: 18, fontWeight: 600, marginTop: 6, marginBottom: 14 }}>Classroom presentation</h3>
          <p style={{ fontSize: 12, color: "var(--c-ink-secondary)", lineHeight: 1.55, marginBottom: 12 }}>
            Seed synthetic incidents to guarantee a populated dashboard for demos without live camera feeds.
          </p>
          <button
            onClick={handleSeed}
            disabled={seeding || seedNeeded === false}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 14px",
              borderRadius: 10,
              fontSize: 12,
              fontWeight: 500,
              border: "1px solid rgba(20,184,166,0.35)",
              cursor: seeding || seedNeeded === false ? "not-allowed" : "pointer",
              background: seedNeeded === false ? "rgba(16,185,129,0.12)" : "rgba(20,184,166,0.15)",
              color: seedNeeded === false ? "#10b981" : "#14b8a6",
              fontFamily: "inherit",
              opacity: seeding ? 0.6 : 1,
            }}
          >
            {seeding ? "Seeding..." : seedNeeded === false ? "Demo data ready" : "Seed demo incidents"}
          </button>
          {seedNeeded === null && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--c-ink-muted)" }}>Checking...</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Analytics Tab ─────────────────────────────────────────────────────────
function AnalyticsTab({ incidents }: { incidents: Incident[] }) {
  const byCat: Record<string, number> = {};
  incidents.forEach((i) => {
    const c = i.classification?.category ?? "OTHER";
    byCat[c] = (byCat[c] ?? 0) + 1;
  });
  const bySev: Record<Severity, number> = { S1: 0, S2: 0, S3: 0, S4: 0 };
  incidents.forEach((i) => {
    bySev[sevOf(i)]++;
  });
  const max = Math.max(1, ...Object.values(byCat));

  // Real metrics from incident data
  const now = Date.now();
  const openIncidents = incidents.filter((i) => !["CLOSED", "DISMISSED"].includes(i.status));

  // Calculate dispatch latency p50 and p95 from incidents with dispatches
  const dispatched = incidents.filter((i) => i.dispatch?.paged_at);
  const dispatchLatencies = dispatched.map((i) => {
    const detected = toEpoch(i.detected_at);
    const paged = toEpoch(i.dispatch?.paged_at ?? i.detected_at);
    return (paged - detected) / 1000;
  });

  const avgLatency = dispatchLatencies.length > 0
    ? Math.round(dispatchLatencies.reduce((a, b) => a + b, 0) / dispatchLatencies.length)
    : null;
  const sortedLatencies = [...dispatchLatencies].sort((a, b) => a - b);
  const p50Idx = Math.floor(sortedLatencies.length * 0.5);
  const p95Idx = Math.floor(sortedLatencies.length * 0.95);
  const dispatchP50 = sortedLatencies.length > 0 ? Math.round(sortedLatencies[p50Idx]) : null;
  const dispatchP95 = sortedLatencies.length > 0 ? Math.round(sortedLatencies[p95Idx]) : null;

  // SLA: percentage of incidents acknowledged within 60 seconds for S1, 5 minutes for others
  const slaMetCount = incidents.filter((i) => {
    const sev = sevOf(i);
    const threshold = sev === "S1" ? 60 : 300;
    const ackTime = toEpoch(i.acknowledged_at ?? i.detected_at);
    const detected = toEpoch(i.detected_at);
    return (ackTime - detected) / 1000 <= threshold;
  }).length;
  const slaPercent = incidents.length > 0 ? Math.round((slaMetCount / incidents.length) * 100) : null;

  // FPR: false positive rate (dismissed / total closed)
  const closed = incidents.filter((i) => i.status === "CLOSED" || i.status === "DISMISSED");
  const dismissed = incidents.filter((i) => i.status === "DISMISSED").length;
  const fpr = closed.length > 0 ? (dismissed / closed.length).toFixed(2) : null;

  // Show demo values when no real data
  const hasRealData = incidents.length > 3;
  const displayP50 = dispatchP50 ?? (hasRealData ? null : "43s");
  const displayP95 = dispatchP95 ?? (hasRealData ? null : "71s");
  const displaySLA = slaPercent !== null ? `${slaPercent}%` : (hasRealData ? "—" : "96%");
  const displayFPR = fpr ?? (hasRealData ? "—" : "0.8");

  return (
    <div style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div className="glass" style={glassStyle({ padding: 20 })}>
        <Eyebrow>By category (all-time)</Eyebrow>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginTop: 6, marginBottom: 14 }}>Incident distribution</h3>
        {Object.keys(byCat).length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--c-ink-muted)" }}>
            {hasRealData ? "No data yet" : "Demo data"}
          </div>
        ) : (
          Object.entries(byCat).map(([c, n]) => (
            <div key={c} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <div style={{ width: 80, fontSize: 12, color: "var(--c-ink-secondary)" }}>{c}</div>
              <div style={{ flex: 1, height: 8, background: "rgba(255,255,255,0.04)", borderRadius: 4, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${(n / max) * 100}%`,
                    background: "linear-gradient(90deg, #14b8a6, #3b82f6)",
                  }}
                />
              </div>
              <div style={{ width: 24, fontFamily: "var(--font-mono)", fontSize: 13, textAlign: "right" }}>{n}</div>
            </div>
          ))
        )}
      </div>
      <div className="glass" style={glassStyle({ padding: 20 })}>
        <Eyebrow>By severity</Eyebrow>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginTop: 6, marginBottom: 14 }}>Pressure mix</h3>
        <div style={{ display: "flex", gap: 10 }}>
          {(Object.keys(bySev) as Severity[]).map((s) => (
            <div
              key={s}
              style={{
                flex: 1,
                padding: 14,
                background: "rgba(255,255,255,0.02)",
                borderRadius: 10,
                borderTop: `3px solid ${SEVERITY_COLOR[s]}`,
              }}
            >
              <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "var(--font-mono)", color: SEVERITY_COLOR[s] }}>
                {bySev[s]}
              </div>
              <div style={{ fontSize: 11, color: "var(--c-ink-muted)", marginTop: 3 }}>{SEV_LABEL[s]}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 18, padding: 14, background: "rgba(255,255,255,0.02)", borderRadius: 10 }}>
          <Eyebrow>Operations scorecard {hasRealData ? "" : "(demo)"}</Eyebrow>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8, fontSize: 13 }}>
            <Score v={displayP50 ?? "—"} c="#14b8a6" l="Dispatch p50" />
            <Score v={displayP95 ?? "—"} c="#f59e0b" l="Dispatch p95" />
            <Score v={displaySLA} c="#10b981" l="SLA met" />
            <Score v={displayFPR} c="#3b82f6" l="FPR" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Small subcomponents ───────────────────────────────────────────────────
function SevBadge({ sev, large }: { sev: Severity; large?: boolean }) {
  const bg = SEVERITY_COLOR[sev];
  const fg = sev === "S3" ? "#0a0e14" : "#fff";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: large ? "4px 11px" : "3px 9px",
        borderRadius: 999,
        fontFamily: "var(--font-mono)",
        fontSize: large ? 11 : 10,
        fontWeight: 600,
        letterSpacing: "0.05em",
        background: bg,
        color: fg,
      }}
    >
      {SEV_LABEL[sev]}
    </span>
  );
}

function StatusDot({ status }: { status: IncidentStatus }) {
  const color = STATUS_COLOR[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 999,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.05em",
        background: "rgba(255,255,255,0.04)",
        border: `1px solid ${color}55`,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: color }} />
      {status.replace("_", " ")}
    </span>
  );
}

function Eyebrow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--c-ink-muted)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: "var(--font-mono)", color: "var(--c-ink-muted)" }}>{children}</span>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 8, padding: "8px 11px" }}>
      <Eyebrow style={{ marginBottom: 2 }}>{label}</Eyebrow>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function Score({ v, c, l }: { v: string; c: string; l: string }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)", color: c }}>{v}</div>
      <div style={{ fontSize: 11, color: "var(--c-ink-muted)" }}>{l}</div>
    </div>
  );
}

// ── Style helpers ─────────────────────────────────────────────────────────
function glassStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    background: "var(--c-bg-panel)",
    border: "1px solid rgba(51,65,85,0.7)",
    borderRadius: 20,
    backdropFilter: "blur(16px)",
    boxShadow: "0 8px 40px rgba(2,6,23,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
    ...extra,
  };
}

function btnTealStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "7px 14px",
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 500,
    border: "none",
    cursor: "pointer",
    background: "#14b8a6",
    color: "#0a0e14",
    fontFamily: "inherit",
    ...extra,
  };
}

function btnGhostStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "7px 14px",
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 500,
    border: "1px solid var(--c-border-strong)",
    cursor: "pointer",
    background: "rgba(255,255,255,0.04)",
    color: "var(--c-ink-secondary)",
    fontFamily: "inherit",
    ...extra,
  };
}

function btnWarnStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "7px 14px",
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 500,
    border: "1px solid rgba(245,158,11,0.3)",
    cursor: "pointer",
    background: "rgba(245,158,11,0.12)",
    color: "#f59e0b",
    fontFamily: "inherit",
    ...extra,
  };
}

// ── Service Health Pills ──────────────────────────────────────────────────
function ServiceHealthPills({ health }: { health: Record<ServiceName, boolean> | null }) {
  const services: ServiceName[] = ["ingest", "vision", "orchestrator", "dispatch"];
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        padding: "4px 8px",
        background: "rgba(255,255,255,0.02)",
        border: "1px solid var(--c-border)",
        borderRadius: 999,
      }}
      title="Backend service health"
    >
      {services.map((s) => {
        const ok = health?.[s];
        const color = ok === true ? "#10b981" : ok === false ? "#dc2626" : "#64748b";
        return (
          <div
            key={s}
            title={`${s} :${SERVICE_PORTS[s]} · ${ok === true ? "healthy" : ok === false ? "down" : "checking"}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 6px",
              borderRadius: 999,
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              color,
              letterSpacing: "0.05em",
              cursor: "help",
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: color,
                animation: ok === true ? "aegis-dot-pulse 2s infinite" : "none",
              }}
            />
            {s.slice(0, 3).toUpperCase()}
          </div>
        );
      })}
    </div>
  );
}

// ── Drill Modal ───────────────────────────────────────────────────────────
function DrillModal({ venueId, onClose }: { venueId: string; onClose: () => void }) {
  const ui = useUI();
  const [steps, setSteps] = React.useState<DrillStep[]>([
    { label: "Upload demo frame → Ingest (:8001)", status: "pending" },
    { label: "Vision · Gemini analyzes frame (:8002)", status: "pending" },
    { label: "Orchestrator · classify + dispatch (:8003)", status: "pending" },
  ]);
  const [running, setRunning] = React.useState(false);

  function update(i: number, patch: Partial<DrillStep>) {
    setSteps((s) => s.map((step, idx) => (idx === i ? { ...step, ...patch } : step)));
  }

  async function trigger() {
    setRunning(true);
    setSteps((s) => s.map((step) => ({ ...step, status: "pending", detail: undefined })));
    try {
      const { ok } = await runDrill(venueId, "kitchen-main", update);
      if (ok) ui.toast("Drill complete · pipeline traced", { tone: "success", title: "Drill" });
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), {
        tone: "danger",
        title: "Drill failed",
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(2,6,23,0.7)",
        backdropFilter: "blur(4px)",
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "aegis-fade-in 0.15s ease-out",
      }}
    >
      <div
        style={{
          background: "rgba(18,24,33,0.98)",
          border: "1px solid rgba(20,184,166,0.3)",
          borderRadius: 18,
          padding: 24,
          maxWidth: 520,
          width: "92%",
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
          animation: "aegis-modal-in 0.18s ease-out",
        }}
      >
        <Eyebrow style={{ color: "#14b8a6", marginBottom: 8 }}>Drill console</Eyebrow>
        <h3 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 600 }}>Fire a synthetic incident</h3>
        <p style={{ margin: 0, fontSize: 12, color: "var(--c-ink-secondary)", lineHeight: 1.55 }}>
          Sends one frame through ingest → vision → orchestrator. Runs in drill_mode so audit
          events are tagged and authority webhooks are gated.
        </p>
        <button
          onClick={trigger}
          disabled={running}
          style={btnTealStyle({ marginTop: 16, padding: "10px 18px", fontSize: 13 })}
        >
          {running ? "Running…" : "Trigger drill"}
        </button>
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {steps.map((s, i) => (
            <div
              key={i}
              style={{
                padding: 12,
                background: "rgba(255,255,255,0.02)",
                border: "1px solid var(--c-border)",
                borderRadius: 10,
                display: "flex",
                gap: 10,
                alignItems: "center",
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: {
                    pending: "#334155",
                    running: "#f59e0b",
                    ok: "#10b981",
                    error: "#dc2626",
                  }[s.status],
                }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13 }}>{s.label}</div>
                {s.detail ? (
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--c-ink-muted)" }}>
                    {s.detail}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={btnGhostStyle({ padding: "8px 16px", fontSize: 13 })}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

