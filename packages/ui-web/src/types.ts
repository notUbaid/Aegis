/**
 * Shared TypeScript types for the Aegis web apps.
 *
 * These mirror the Pydantic schemas in `services/shared/aegis_shared/schemas.py`.
 * Keep them in sync manually for now; Phase 2 generates them from JSON Schema.
 */

export type IncidentCategory =
  | "FIRE"
  | "MEDICAL"
  | "STAMPEDE"
  | "VIOLENCE"
  | "SUSPICIOUS"
  | "OTHER";

export type Severity = "S1" | "S2" | "S3" | "S4";

export type IncidentStatus =
  | "DETECTED"
  | "CLASSIFIED"
  | "DISPATCHED"
  | "ACKNOWLEDGED"
  | "EN_ROUTE"
  | "ON_SCENE"
  | "TRIAGED"
  | "RESOLVING"
  | "VERIFIED"
  | "CLOSED"
  | "DISMISSED"
  | "NOTE";

export type DispatchStatus =
  | "PAGED"
  | "ACKNOWLEDGED"
  | "DECLINED"
  | "EN_ROUTE"
  | "ARRIVED"
  | "HANDED_OFF"
  | "TIMED_OUT";

export interface CascadePrediction {
  horizon_seconds: number;
  outcome: string;
  probability: number;
}

export interface IncidentClassification {
  category: IncidentCategory;
  sub_type?: string | null;
  severity: Severity;
  confidence: number;
  rationale: string;
  cascade_predictions: CascadePrediction[];
}

export interface Incident {
  incident_id: string;
  venue_id: string;
  zone_id: string;
  status: IncidentStatus;
  classification?: IncidentClassification | null;
  detected_at: string;
  resolved_at?: string | null;
  summary: string;
  agent_trace_id?: string | null;
  s1_hitl_gated?: boolean;
  advisory_dispatch_plan?: Record<string, unknown> | null;
}

export interface Dispatch {
  dispatch_id: string;
  venue_id: string;
  incident_id: string;
  responder_id: string;
  role: string;
  status: DispatchStatus;
  paged_at: string;
  acknowledged_at?: string | null;
  en_route_at?: string | null;
  arrived_at?: string | null;
  handed_off_at?: string | null;
  required_skills?: string[];
  notes: string;
}

export interface IncidentEvent {
  event_id: string;
  event_time: string;
  venue_id: string;
  incident_id: string;
  from_status?: IncidentStatus | null;
  to_status: IncidentStatus;
  actor_type: "agent" | "human" | "system";
  actor_id: string;
  payload: Record<string, unknown>;
}

/** Color tokens lifted from blueprint §47. */
export const SEVERITY_COLOR: Record<Severity, string> = {
  S1: "#DC2626",
  S2: "#EF4444",
  S3: "#F59E0B",
  S4: "#3B82F6",
};

export const STATUS_COLOR: Record<IncidentStatus, string> = {
  DETECTED: "#94A3B8",
  CLASSIFIED: "#3B82F6",
  DISPATCHED: "#F59E0B",
  ACKNOWLEDGED: "#F59E0B",
  EN_ROUTE: "#F59E0B",
  ON_SCENE: "#14B8A6",
  TRIAGED: "#14B8A6",
  RESOLVING: "#10B981",
  VERIFIED: "#10B981",
  CLOSED: "#64748B",
  DISMISSED: "#64748B",
  NOTE: "#8B5CF6",
};

export const DISPATCH_STATUS_COLOR: Record<DispatchStatus, string> = {
  PAGED: "#F59E0B",
  ACKNOWLEDGED: "#3B82F6",
  DECLINED: "#94A3B8",
  EN_ROUTE: "#3B82F6",
  ARRIVED: "#14B8A6",
  HANDED_OFF: "#10B981",
  TIMED_OUT: "#DC2626",
};
