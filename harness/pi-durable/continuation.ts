// Continue the builder on selected, explicitly uncarried product items.
import { join } from 'node:path';
import { Effect } from 'effect';
import { isSelectedChecklist, type SelectedChecklist } from './contracts.ts';
import {
  InvalidWorkspaceData,
  readWorkspaceJson,
  WorkspaceFiles,
  WorkspaceFilesLive,
} from './workspace-effects.ts';

export const MAX_CONTINUATIONS = 3;

export function extractUncarried(checklist: SelectedChecklist, text: string): string[] {
  const selected = new Set(checklist.items.map((item) => item.id));
  const ids = new Set<string>();
  for (const match of text.matchAll(/^\s*[-*]\s*`?@item-(\d{2}-\d{3})\b/gm))
    if (selected.has(match[1])) ids.add(match[1]);
  return [...ids].sort();
}

export function selectedUncarriedEffect(room: string, checklistFile: string) {
  return Effect.gen(function* () {
    const files = yield* WorkspaceFiles;
    const file = join(room, 'impl', 'UNCARRIED.md');
    if (!(yield* files.exists(file))) return [];
    const checklist: unknown = yield* readWorkspaceJson(checklistFile);
    if (!isSelectedChecklist(checklist))
      return yield* Effect.fail(
        new InvalidWorkspaceData({
          path: checklistFile,
          reason: 'invalid selected checklist',
        }),
      );
    return extractUncarried(checklist, yield* files.readText(file));
  });
}

// The Pi task still calls a synchronous function; only this edge runs Effect.
export function selectedUncarried(room: string, checklistFile: string): string[] {
  return Effect.runSync(
    selectedUncarriedEffect(room, checklistFile).pipe(Effect.provide(WorkspaceFilesLive)),
  );
}

export function continuationPrompt(ids: string[]): string {
  if (!ids.length || ids.some((id) => !/^\d{2}-\d{3}$/.test(id)))
    throw new Error('continuation needs selected product item IDs');
  return `Your turn ended with these selected product items still listed in impl/UNCARRIED.md: ${ids.map((id) => `@item-${id}`).join(', ')}. Carry them now. For each, write a failing test that drives it through the public HTTP surface and names its id, make it pass with the smallest real change, keep the whole suite green, and remove its line from impl/UNCARRIED.md. Leave a line only for an item you truly cannot carry, with the reason. Then rerun impl/test.sh, start impl/start.sh on a free port, confirm the page and harness/probe.sh over HTTP, and stop the server. The clean-room boundary and write scope from the first turn still apply. Done is decided by the gate and the score, not by you.\n`;
}
