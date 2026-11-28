// Minimal @earendil-works/{pi-durable,pi-coding-agent,pi-env,chord} builder session shim.
// Policy, prompt text, timeout clamping, receipt lineage validation, and steer
// inbox scanning live in harness/loyly-clj (loyly.builder-host .cljc +
// loyly.node.builder-host .cljs).
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai';
import {
  DEFAULT_MAX_BYTES,
  type FindOperations,
  type GrepToolDetails,
  type GrepToolInput,
  type LsOperations,
  createFindTool,
  createGrepTool,
  createLsTool,
  formatSize,
  truncateHead,
  truncateLine,
} from '@earendil-works/pi-coding-agent';
import {
  AssistantEntry,
  Harness,
  type ToolRegistration,
  createRegistry,
  defineExtension,
  defineTool,
  section,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { Connection, RemoteExecutionEnv } from '@earendil-works/pi-env';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ctx = BACKGROUND_CONTEXT;

type PiResult = { content: Array<{ type: string; text?: string }>; details?: unknown };
type PiTool = {
  name: string;
  description: string;
  parameters: object;
  execute(id: string, params: never, signal?: AbortSignal): Promise<PiResult>;
};

function must<T>(result: { ok: true; value: T } | { ok: false; error: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error.message ?? 'env error');
  return result.value;
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
  if (pattern.includes('/')) {
    return (
      path.posix.matchesGlob(relativePath, pattern) ||
      path.posix.matchesGlob(relativePath, `**/${pattern}`)
    );
  }
  return path.posix.matchesGlob(path.posix.basename(relativePath), pattern);
}

async function listFiles(env: ExecutionEnv, root: string, context: Context): Promise<string[]> {
  if (!env.listFiles) throw new Error('the environment cannot list files');
  const listing = must(await env.listFiles(root, { exclude: ['node_modules'] }, context));
  return listing.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path);
}

function lsOps(env: ExecutionEnv, context: Context): LsOperations {
  return {
    exists: async (p) => must(await env.exists(p, context)),
    stat: async (p) => {
      const info = must(await env.fileInfo(p, context));
      return { isDirectory: () => info.kind === 'directory' };
    },
    readdir: async (p) => must(await env.listDir(p, context)).map((entry) => entry.name),
  };
}

function findOps(env: ExecutionEnv, context: Context): FindOperations {
  return {
    exists: lsOps(env, context).exists,
    glob: async (pattern, cwd, options) => {
      const results: string[] = [];
      for (const relative of await listFiles(env, cwd, context)) {
        if (results.length >= options.limit) break;
        if (matchesToolGlob(relative, pattern)) results.push(path.posix.join(cwd, relative));
      }
      return results;
    },
  };
}

async function grepInEnv(
  env: ExecutionEnv,
  workspace: string,
  params: GrepToolInput,
  context: Context,
): Promise<PiResult> {
  const root = path.posix.resolve(workspace, params.path ?? '.');
  const rootIsDirectory = must(await env.fileInfo(root, context)).kind === 'directory';
  const files = rootIsDirectory ? await listFiles(env, root, context) : [path.posix.basename(root)];
  const base = rootIsDirectory ? root : path.posix.dirname(root);
  const needle = params.ignoreCase ? params.pattern.toLowerCase() : params.pattern;
  const regex = params.literal ? null : new RegExp(params.pattern, params.ignoreCase ? 'i' : undefined);
  const matchesLine = (line: string) =>
    regex ? regex.test(line) : (params.ignoreCase ? line.toLowerCase() : line).includes(needle);
  const contextLines = params.context && params.context > 0 ? params.context : 0;
  const limit = Math.max(1, params.limit ?? 100);
  const out: string[] = [];
  const details: GrepToolDetails = {};
  let matches = 0;
  let limitReached = false;
  let linesTruncated = false;
  for (const relative of files) {
    if (matches >= limit) break;
    if (params.glob && !matchesToolGlob(relative, params.glob)) continue;
    const text = await env.readTextFile(path.posix.join(base, relative), context);
    if (!text.ok) continue;
    const lines = text.value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (context.abortSignal?.aborted) throw new Error('Operation aborted');
      if (!matchesLine(lines[i] ?? '')) continue;
      matches++;
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      for (let j = start; j <= end; j++) {
        const { text: line, wasTruncated } = truncateLine((lines[j] ?? '').replace(/\r/g, ''));
        if (wasTruncated) linesTruncated = true;
        out.push(`${relative}${j === i ? ':' : '-'}${j + 1}${j === i ? ':' : '-'} ${line}`);
      }
      if (matches >= limit) {
        limitReached = true;
        break;
      }
    }
  }
  if (matches === 0) return { content: [{ type: 'text', text: 'No matches found' }] };
  const truncation = truncateHead(out.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
  const notices: string[] = [];
  if (limitReached) {
    details.matchLimitReached = limit;
    notices.push(`${limit} matches limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push('long lines truncated');
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  const text =
    notices.length > 0 ? `${truncation.content}\n\n[${notices.join('. ')}]` : truncation.content;
  return {
    content: [{ type: 'text', text }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

function buildTools(workspace: string): Record<string, ToolRegistration> {
  const wrap = (
    proto: PiTool,
    run: (env: ExecutionEnv, args: never, c: Context) => Promise<PiResult>,
  ): ToolRegistration =>
    defineTool({
      name: proto.name,
      description: proto.description,
      parameters: proto.parameters,
      execute: async (args, api, c) => {
        if (!api.env) throw new Error('no environment');
        const result = await run(api.env, args as never, c);
        return {
          output: result.content.map((item) => ({ type: 'text' as const, text: item.text ?? '' })),
          ...(result.details === undefined
            ? {}
            : { details: JSON.parse(JSON.stringify(result.details)) }),
        };
      },
    });
  return {
    ...Object.fromEntries(
      (CodingTools.tools ?? []).map((tool) => [tool.name, tool as ToolRegistration]),
    ),
    ls: wrap(createLsTool(workspace) as unknown as PiTool, (env, args, c) =>
      (createLsTool(workspace, { operations: lsOps(env, c) }) as unknown as PiTool).execute(
        'ls',
        args,
        c.abortSignal,
      ),
    ),
    find: wrap(createFindTool(workspace) as unknown as PiTool, (env, args, c) =>
      (createFindTool(workspace, { operations: findOps(env, c) }) as unknown as PiTool).execute(
        'find',
        args,
        c.abortSignal,
      ),
    ),
    grep: wrap(createGrepTool(workspace) as unknown as PiTool, (env, args, c) =>
      grepInEnv(env, workspace, args, c),
    ),
  };
}

export async function resolvePiSettingsTools(file: string, workspace: string): Promise<string[]> {
  const { SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const allTools = buildTools(workspace);
  const tools = SettingsManager.inMemory(JSON.parse(readFileSync(file, 'utf8'))).getDefaultTools();
  if (!tools?.length) throw new Error(`${file}: no defaultTools`);
  const unknown = tools.filter((name) => !(name in allTools));
  if (unknown.length) {
    throw new Error(
      `${file}: unknown tools ${unknown.join(', ')} (known: ${Object.keys(allTools).join(', ')})`,
    );
  }
  return tools;
}

export async function openModelRuntime(model: { provider: string; modelId: string }) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const models = await ModelRuntime.create({ refreshOnCreate: false });
  if (!models.getModel(model.provider, model.modelId)) {
    throw new Error(`model not found: ${model.provider}/${model.modelId}`);
  }
  if (!(await models.listCredentials()).some((c) => c.providerId === model.provider)) {
    throw new Error(
      `no ${model.provider} login in pi's auth store; log in with pi first (this host never logs in)`,
    );
  }
  return models;
}

export interface BuilderSessionOptions {
  room: string;
  store: string;
  requestId: string;
  content: string;
  environmentPrompt: string;
  workspace: string;
  tools: string[];
  model: { provider: string; modelId: string };
  models: Models;
  clampTimeout: (requested: unknown) => number | undefined;
  existingConversationId?: number;
  forkFrom?: { conversationId: number; lastEntryId: number };
  onConversationReady?: (info: {
    conversationId: number;
    parentConversationId: number | null;
    forkEntryId: number | null;
  }) => void;
  onSettledLastEntry?: (lastEntryId: number | null) => void;
  pollSteer?: (
    submitSteer: (input: { content: string; requestId: string }) => Promise<{ id: unknown }>,
  ) => Promise<void>;
  log?: (text: string) => void;
}

export async function runBuilderSession(opts: BuilderSessionOptions) {
  const log = opts.log ?? ((text: string) => process.stderr.write(`${text}\n`));
  const connection = new Connection({
    command: [process.execPath, path.join(HERE, 'gondolin-vm.ts'), path.resolve(opts.room)],
    onLog: (text) => log(`[pi-env] ${text.trimEnd()}`),
  });
  const env = new RemoteExecutionEnv({
    connection,
    id: `gondolin:${path.basename(opts.room)}`,
    cwd: opts.workspace,
  });
  const allTools = buildTools(opts.workspace);
  const tools = opts.tools.map((name) => {
    const tool = allTools[name]!;
    if (name !== 'bash') return tool;
    return {
      ...tool,
      execute: (args: unknown, api: unknown, c: Context) => {
        const bounded = opts.clampTimeout((args as { timeout?: unknown }).timeout);
        const nextArgs =
          bounded === undefined ? args : { ...(args as object), timeout: bounded };
        return tool.execute(nextArgs as never, api as never, c);
      },
    };
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'loyly-builder',
      tools,
      sections: [section('environment', () => opts.environmentPrompt, { tag: false })],
    }),
  );
  const harness = await Harness.open(
    await openNodeSqliteStorage(opts.store),
    { models: opts.models, registry, env: () => env },
    ctx,
  );
  let root: Awaited<ReturnType<typeof harness.root>> | undefined;
  let terminated = false;
  const onTerm = () => {
    terminated = true;
    log('SIGTERM: aborting the run');
    root?.abort(ctx).catch((error) => log(`abort: ${String(error)}`));
  };
  process.once('SIGTERM', onTerm);
  let steering: ReturnType<typeof setInterval> | undefined;
  try {
    harness.resume();
    if (opts.existingConversationId !== undefined) {
      const existing = await harness.conversation(opts.existingConversationId as never, ctx);
      if (!existing) throw new Error('Pi conversation receipt names a missing conversation');
      root = existing;
    } else if (opts.forkFrom) {
      const source = await harness.conversation(opts.forkFrom.conversationId as never, ctx);
      if (!source) throw new Error('prior Pi conversation is missing');
      root = await source.fork(
        opts.forkFrom.lastEntryId as never,
        { ownership: { kind: 'ownerless' } },
        ctx,
      );
      opts.onConversationReady?.({
        conversationId: Number(root.id),
        parentConversationId: Number(source.id),
        forkEntryId: opts.forkFrom.lastEntryId,
      });
    } else {
      root = await harness.root(ctx, {
        agent: { model: opts.model, thinkingLevel: 'high', cwd: opts.workspace },
      });
      opts.onConversationReady?.({
        conversationId: Number(root.id),
        parentConversationId: null,
        forkEntryId: null,
      });
    }
    if (terminated) throw new Error('SIGTERM before the submission; nothing submitted');
    const submission = await root.submit(
      { type: 'input', content: opts.content, requestId: opts.requestId },
      ctx,
    );
    log(`submission ${submission.id} request ${opts.requestId}`);
    if (opts.pollSteer) {
      const target = root;
      const poll = opts.pollSteer;
      let busy = false;
      steering = setInterval(() => {
        if (busy) return;
        busy = true;
        poll(({ content, requestId }) =>
          target.submit(
            { type: 'input', content, requestId, whenBusy: 'steer', whenIdle: 'reject' },
            ctx,
          ),
        ).finally(() => {
          busy = false;
        });
      }, 5000);
    }
    const settled = await submission.wait(ctx);
    let answer: string | undefined;
    if (settled.status === 'done' && settled.type === 'input') {
      const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
      answer = (entry?.model ?? [])
        .flatMap((m: { content?: unknown }) => (Array.isArray(m.content) ? m.content : []))
        .filter((c: { type?: string }) => c.type === 'text')
        .map((c: { text?: string }) => c.text ?? '')
        .join('\n');
    }
    if (opts.onSettledLastEntry) {
      const latest = await root.entries({}, 1, undefined, ctx);
      const id = latest.items[0]?.id;
      opts.onSettledLastEntry(id === undefined ? null : Number(id));
    }
    return { settled, answer };
  } finally {
    if (steering) clearInterval(steering);
    process.off('SIGTERM', onTerm);
    await harness.close(ctx);
    connection.close();
  }
}
