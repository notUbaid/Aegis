/* eslint-disable */
"use client";

/**
 * Global error boundary for the Staff app.
 * Catches unhandled errors in any child route or component.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "2rem",
        fontFamily: "var(--font-body)",
        background: "var(--color-bg)",
        color: "var(--color-fg)",
      }}
    >
      <h1 style={{ fontSize: "2rem", marginBottom: "1rem" }}>
        Oops — something broke
      </h1>
      <p
        style={{
          color: "var(--color-muted)",
          marginBottom: "1.5rem",
          maxWidth: 480,
          textAlign: "center",
        }}
      >
        We hit an unexpected error. You can refresh the page or head back to
        the dashboard.
      </p>
      <button
        onClick={reset}
        style={{
          background: "var(--color-accent)",
          color: "white",
          border: "none",
          borderRadius: 8,
          padding: "0.75rem 1.5rem",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Refresh
      </button>
    </div>
  );
}
