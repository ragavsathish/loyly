// The legacy carry-slice! rule for the original 01-booking-core cut.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_CONTINUATIONS = 3;

export function selectedUncarried(room, checklistFile) {
  const file = join(room, "impl", "UNCARRIED.md");
  if (!existsSync(file)) return [];
  const selected = new Set(JSON.parse(readFileSync(checklistFile, "utf8")).items.map((item) => item.id));
  const ids = new Set();
  for (const match of readFileSync(file, "utf8").matchAll(/^\s*[-*]\s*`?@item-(01-\d{3})/gm))
    if (selected.has(match[1])) ids.add(match[1]);
  return [...ids].sort();
}

export function continuationPrompt(ids) {
  if (!ids.length || ids.some((id) => !/^01-\d{3}$/.test(id)))
    throw new Error("continuation needs selected booking-core item IDs");
  return `Your turn ended with these items of your slice still listed in impl/UNCARRIED.md: ${ids.map((id) => `@item-${id}`).join(", ")}. Carry them now. For each, write a failing test that drives it through the public HTTP surface and names its id, make it pass with the smallest real change, keep the whole suite green, and remove its line from impl/UNCARRIED.md. Leave a line only for an item you truly cannot carry, with the reason. Then rerun impl/test.sh, start impl/start.sh on a free port, confirm the page and harness/probe.sh over HTTP, and stop the server. The clean-room boundary and write scope from the first turn still apply. Done is decided by the gate and the score, not by you.\n`;
}
