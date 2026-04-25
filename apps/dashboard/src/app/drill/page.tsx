"use client";

import * as React from "react";
import Link from "next/link";
import { runDrill, type DrillStep } from "@/lib/actions";
import { useUI } from "@/lib/ui";

const VENUE_ID = process.env.NEXT_PUBLIC_DEMO_VENUE_ID || "taj-ahmedabad";

const INITIAL_STEPS: DrillStep[] = [
  { label: "Upload demo frame → Ingest (:8001)", status: "pending" },
  { label: "Vision · Gemini analyzes frame (:8002)", status: "pending" },
  { label: "Orchestrator · classify + dispatch (:8003)", status: "pending" },
];

export default function DrillPage() {
  const ui = useUI();
  const [steps, setSteps] = React.useState<DrillStep[]>(INITIAL_STEPS);
  const [running, setRunning] = React.useState(false);

  function update(i: number, patch: Partial<DrillStep>) {
    setSteps((s) => s.map((step, idx) => (idx === i ? { ...step, ...patch } : step)));
  }

  async function trigger() {
    setRunning(true);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s })));
    try {
      const { ok } = await runDrill(VENUE_ID, "kitchen-main", update);
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
    <main className="dashboard-shell">
      <div
        style={{
          maxWidth: 880,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <header className="panel" style={{ padding: 28 }}>
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
            DRILL CONSOLE
          </div>
          <h1
            style={{
              margin: "10px 0 10px",
              fontSize: "clamp(2.1rem, 2vw + 1.4rem, 3.6rem)",
              lineHeight: 1.02,
            }}
          >
            Fire a synthetic incident
          </h1>
          <p
            style={{
              margin: 0,
              color: "var(--c-ink-secondary)",
              fontSize: 15,
              maxWidth: 720,
            }}
          >
            Sends one synthetic frame end-to-end through Ingest → Vision → Orchestrator.
            Pipeline runs in <code>drill_mode</code> so audit events are tagged and authority
            webhooks are gated.
          </p>

          <button
            onClick={trigger}
            disabled={running}
            style={{
              marginTop: 24,
              background: "#14B8A6",
              color: "#0A0E14",
              border: "none",
              borderRadius: 10,
              padding: "16px 22px",
              fontSize: 16,
              fontWeight: 600,
              cursor: running ? "not-allowed" : "pointer",
              opacity: running ? 0.6 : 1,
            }}
          >
            {running ? "Running..." : "Trigger drill"}
          </button>
        </header>

        <section
          className="panel"
          style={{ padding: 22, display: "flex", flexDirection: "column", gap: 10 }}
        >
          <div className="eyebrow">Pipeline trace</div>
          {steps.map((s, i) => (
            <div
              key={i}
              style={{
                padding: 14,
                background: "rgba(8, 15, 24, 0.72)",
                border: "1px solid rgba(51, 65, 85, 0.92)",
                borderRadius: 14,
                display: "flex",
                gap: 12,
                alignItems: "center",
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  background: {
                    pending: "#334155",
                    running: "#F59E0B",
                    ok: "#10B981",
                    error: "#DC2626",
                  }[s.status],
                }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15 }}>{s.label}</div>
                {s.detail ? (
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      color: "var(--c-ink-muted)",
                      marginTop: 4,
                    }}
                  >
                    {s.detail}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
