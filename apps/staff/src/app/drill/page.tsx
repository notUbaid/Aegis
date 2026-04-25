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
    <main className="app-bg" style={{ padding: 16, maxWidth: 640, margin: "0 auto", minHeight: "100vh" }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.16em",
          color: "var(--c-ink-muted)",
        }}
      >
        AEGIS · DRILL
      </div>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: "6px 0 12px" }}>Fire a demo incident</h1>
      <p style={{ color: "var(--c-ink-secondary)", marginTop: 0 }}>
        Sends one synthetic frame end-to-end through Ingest → Vision → Orchestrator. Use this
        during the judge demo to show the 4-second detection-to-dispatch path live.
      </p>

      <button
        onClick={trigger}
        disabled={running}
        style={{
          marginTop: 16,
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

      <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 8 }}>
        {steps.map((s, i) => (
          <div
            key={i}
            style={{
              padding: 12,
              background: "var(--c-bg-elevated)",
              border: "1px solid var(--c-border)",
              borderRadius: 8,
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
                  running: "#F59E0B",
                  ok: "#10B981",
                  error: "#DC2626",
                }[s.status],
              }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14 }}>{s.label}</div>
              {s.detail ? (
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    color: "var(--c-ink-muted)",
                  }}
                >
                  {s.detail}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 40, borderTop: "1px solid var(--c-border)", paddingTop: 18 }}>
        <Link href="/" style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>
          ← INCIDENTS
        </Link>
      </div>
    </main>
  );
}
