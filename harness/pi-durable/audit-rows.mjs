// Read only committed Pi audit entries. Neither replay nor reports infer events
// from mutable scratch files.
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export async function readAuditRows(dir) {
  const ctx = BACKGROUND_CONTEXT;
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "cycle.PROTOTYPE.sqlite")),
    { models: createModels(), registry: createRegistry(), readOnly: true }, ctx);
  try {
    const conversation = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
    if (!conversation) throw new Error(`no root conversation in ${dir}`);
    const entries = [];
    let cursor;
    do {
      const page = await conversation.entries({ order: "ascending" }, 100, cursor, ctx);
      entries.push(...page.items.filter((entry) => entry.kind === "loyly.proto.audit.v1"));
      cursor = page.next;
    } while (cursor);
    return entries.map((entry, index) => ({ seq: index + 1, entry_id: String(entry.id), ...entry.data }));
  } finally { await harness.close(ctx); }
}
