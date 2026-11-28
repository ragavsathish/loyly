// Minimal @earendil-works/pi-durable integration shim.
// All cycle logic, contracts, digests, grading, blind review, panel, and scoring
// live in harness/loyly-clj (.cljc primary core + .cljs Node adapters).
// This file wraps ONLY the @earendil-works/pi-durable / chord / pi-ai SDK boundary.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import {
  Harness,
  ROOT_CONVERSATION_ID,
  createRegistry,
  defineEntry,
  defineExtension,
  defineTask,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

export interface AuditRow {
  seq: number;
  entry_id: string;
  [key: string]: unknown;
}

export type AuditFn = (
  tx: unknown,
  task: { id: unknown; conversationId: unknown },
  stage: string,
  outcome: string,
  extra?: Record<string, unknown>,
) => Promise<unknown>;

export interface DurableTaskSpec {
  name: string;
  initial: () => Record<string, unknown>;
  phases: Record<string, (task: unknown, runtime: unknown, ctx: unknown) => Promise<unknown>>;
}

export interface DurableCycleOptions {
  storePath: string;
  scratch: string;
  runId: string;
  mode: string;
  cycleInput: Record<string, unknown>;
  buildTasks: (helpers: {
    audit: AuditFn;
    ctx: typeof BACKGROUND_CONTEXT;
  }) => {
    builder: DurableTaskSpec;
    gate: DurableTaskSpec;
    grade: DurableTaskSpec;
    panel: DurableTaskSpec;
    cycle: (refs: { Builder: unknown; Gate: unknown; Grade: unknown; Panel: unknown }) => DurableTaskSpec;
  };
}

const AUDIT_SCHEMA = 'loyly.proto.audit.v1';

export async function readAuditRows(dir: string): Promise<AuditRow[]> {
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
        ...(page.items.filter((entry) => entry.kind === AUDIT_SCHEMA) as typeof entries),
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

function wrapTask(spec: DurableTaskSpec, ctx: typeof BACKGROUND_CONTEXT) {
  const phases: Record<string, (task: unknown, runtime: unknown) => Promise<unknown>> = {};
  for (const [name, fn] of Object.entries(spec.phases)) {
    phases[name] = (task, runtime) => fn(task, runtime, ctx);
  }
  return defineTask({
    name: spec.name,
    version: 1,
    initial: spec.initial,
    phases,
    abort: (_task: unknown, runtime: { commit: (fn: () => unknown, c: unknown) => Promise<unknown> }) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  } as never);
}

export async function runDurableCycle(opts: DurableCycleOptions): Promise<{
  id: unknown;
  final: unknown;
}> {
  const ctx = BACKGROUND_CONTEXT;
  const Audit = defineEntry(AUDIT_SCHEMA);
  const audit: AuditFn = async (tx, task, stage, outcome, extra = {}) => {
    const data = {
      schema: AUDIT_SCHEMA,
      run_id: opts.runId,
      stage,
      outcome,
      at: new Date().toISOString(),
      task_id: String(task.id),
      ...extra,
    };
    const entry = await (tx as {
      appendEntry: (kind: unknown, conv: unknown, payload: unknown) => Promise<{ id: unknown }>;
    }).appendEntry(Audit, task.conversationId, { data });
    console.log(
      `${entry.id} ${stage} ${outcome}${(data as { attempt?: unknown }).attempt ? ` attempt ${(data as { attempt?: unknown }).attempt}` : ''}`,
    );
    return entry;
  };

  const specs = opts.buildTasks({ audit, ctx });
  const Builder = wrapTask(specs.builder, ctx);
  const Gate = wrapTask(specs.gate, ctx);
  const Grade = wrapTask(specs.grade, ctx);
  const Panel = wrapTask(specs.panel, ctx);
  const Cycle = wrapTask(specs.cycle({ Builder, Gate, Grade, Panel }), ctx);

  const registry = createRegistry();
  registry.install(
    defineExtension({ name: 'loyly-prototype', tasks: [Builder, Gate, Grade, Panel, Cycle] }),
  );
  const harness = await Harness.open(
    await openNodeSqliteStorage(opts.storePath),
    { models: createModels(), registry },
    ctx,
  );
  try {
    const root = await harness.root(ctx);
    const existing = await harness.commit(
      (tx) => tx.scanTasks({ kind: 'loyly.proto.cycle' }, 10),
      ctx,
    );
    const existingItem = existing.items[0];
    let id = existingItem?.id;
    if (
      existingItem &&
      JSON.stringify(existingItem.input) !== JSON.stringify(opts.cycleInput)
    ) {
      throw new Error('this Pi store belongs to a different approved cut, checklist or mode');
    }
    if (id === undefined) {
      id = (await harness.commit(
        (tx) =>
          tx.createTask(Cycle, opts.cycleInput as never, {
            ownership: { kind: 'conversation' },
            conversationId: root.id,
          }),
        ctx,
      )) as typeof existingItem extends { id: infer T } ? T : never;
    }
    const taskId = id!;
    writeFileSync(join(opts.scratch, 'task-id'), String(taskId));
    console.log(`cycle task ${taskId}; mode ${opts.mode}; store ${opts.storePath}`);
    harness.resume();
    const final = await harness.waitForTask(taskId, ctx);
    console.log('FINAL', JSON.stringify(final));
    return { id: taskId, final };
  } finally {
    await harness.close(ctx);
  }
}
