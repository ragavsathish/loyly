import type { SelectedChecklist } from "./types.ts";

export interface SelectionCheck {
  id: string;
  source: string;
  role: string;
  items: string[];
}
export interface SelectionPlan {
  checks: SelectionCheck[];
}

export function validatePanelCoverage(
  plan: SelectionPlan,
  checklist: SelectedChecklist,
  handoffItem?: string,
): { selected: string[]; specialistIds: string[] } {
  const ids = checklist?.items?.map((item) => item.id);
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
    throw new Error("panel selection needs a unique scored checklist");
  const selected = new Set(ids);
  if (handoffItem && !selected.has(handoffItem))
    throw new Error(
      `blind handoff requires selected item ${handoffItem}`,
    );
  const checkIds = plan.checks.map((check) => check.id);
  if (new Set(checkIds).size !== checkIds.length)
    throw new Error("panel check IDs must be unique");
  const raw = plan.checks.filter((check) => check.source === "raw-grader");
  const rawIds = raw.flatMap((check) => check.items);
  if (
    rawIds.length !== ids.length ||
    new Set(rawIds).size !== ids.length ||
    rawIds.some((id) => !selected.has(id))
  )
    throw new Error(
      "raw grader checks must exactly cover selected checklist items",
    );
  if (
    raw.some((check) =>
      check.items.some(
        (id) =>
          check.role !==
          (handoffItem && id === handoffItem ? "handoff" : "scored"),
      ),
    )
  )
    throw new Error("raw grader roles differ from the selected blind handoff");
  const blind = plan.checks.filter((check) => check.source === "blind-review");
  if (
    handoffItem
      ? blind.length !== 1 ||
        blind[0]?.role !== "scored" ||
        blind[0].items.length !== 1 ||
        blind[0].items[0] !== handoffItem
      : blind.length !== 0
  )
    throw new Error(
      `panel needs one scored blind review for ${handoffItem ?? "selected item"}`,
    );
  const specialists = plan.checks.filter(
    (check) => check.source === "specialist",
  );
  if (
    specialists.some(
      (check) => !["corroborating", "diagnostic"].includes(check.role),
    )
  )
    throw new Error(
      "specialist checks may corroborate or diagnose, not file a score",
    );
  if (specialists.some((check) => check.items.some((id) => !selected.has(id))))
    throw new Error("specialist check names an unselected item");
  return { selected: ids, specialistIds: specialists.map((check) => check.id) };
}
