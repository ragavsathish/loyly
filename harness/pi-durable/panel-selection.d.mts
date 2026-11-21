export function validatePanelSelection(
  plan: unknown,
  checklist: { items: { id: string; source?: string }[] },
): { selected: string[]; specialists: string[] };
