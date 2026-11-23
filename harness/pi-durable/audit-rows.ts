// Read only committed Pi audit entries. Neither replay nor reports infer events
// from mutable scratch files.
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { Harness, createRegistry, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

interface AuditRow {
  seq: number;
  entry_id: string;
  [key: string]: unknown;
}

async function readAuditRows(dir: string): Promise<AuditRow[]> {
  const ctx = BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, 'cycle.PROTOTYPE.sqlite')),
    { models: createModels(), registry: createRegistry(), readOnly: true },
    ctx,
  );
  try {
    const conversation = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
    if (!conversation) throw new Error(`no root conversation in ${dir}`);
    const entries: { id: string | number; kind: string; data: Record<string, unknown> }[] = [];
    let cursor: unknown;
    do {
      const page = await conversation.entries({ order: 'ascending' }, 100, cursor as never, ctx);
      entries.push(
        ...(page.items.filter((entry) => entry.kind === 'loyly.proto.audit.v1') as typeof entries),
      );
      cursor = page.next;
    } while (cursor);
    return entries.map((entry, index) => ({
      seq: index + 1,
      entry_id: String(entry.id),
      ...entry.data,
    }));
  } finally {
    await harness.close(ctx);
  }
}

export type { AuditRow };
export { readAuditRows };
