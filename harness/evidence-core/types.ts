export type PanelRole = "scored" | "handoff" | "corroborating" | "diagnostic";
export type PanelStatus = "passed" | "failed" | "broken" | "skipped";
export type FiledVerdict = "pass" | "fail";

export interface SelectedItem {
  id: string;
}
export interface SelectedChecklist {
  items: SelectedItem[];
}
export interface Verdict {
  id: string;
  verdict: FiledVerdict;
  evidence: string;
}
export interface Surprise {
  item: string;
  observation: string;
  evidence_file: string;
}

export function isSelectedChecklist(
  value: unknown,
): value is SelectedChecklist {
  return (
    typeof value === "object" &&
    value !== null &&
    "items" in value &&
    Array.isArray(value.items) &&
    value.items.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        typeof item.id === "string",
    )
  );
}

export interface PanelCheck {
  id: string;
  source: "raw-grader" | "blind-review" | "specialist";
  role: PanelRole;
  tool: string;
  technique: string;
  items: string[];
  criterion: string;
  failure: string;
  target_runtime: string;
}
export interface PanelPlan {
  checks: PanelCheck[];
}
export interface ScoredItem {
  id: string;
  rule: string;
  verdict: FiledVerdict;
}
export interface PanelObservation {
  id: string;
  item: string;
  tool: string;
  technique: string;
  status: PanelStatus;
  runtime: string;
  result_sha256: string;
  message: string;
}
export interface PanelCheckResult extends PanelObservation {
  role: PanelRole;
  target_runtime: string;
  criterion: string;
  failure: string;
}
export interface PanelItemResult {
  id: string;
  rule: string;
  filed_verdict: FiledVerdict;
  check_ids: string[];
  panel_status: "supported" | "failed" | "conflicted";
}
export interface PanelEvaluation {
  checks: PanelCheckResult[];
  items: PanelItemResult[];
  gaps: string[];
  panel_outcome: "ready-for-review" | "not-ready";
}
