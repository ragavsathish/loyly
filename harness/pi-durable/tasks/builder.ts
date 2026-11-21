import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineTask } from '@earendil-works/pi-durable';
import type { TaskOutcome } from '@earendil-works/pi-durable';
import { hash } from '../cycle-effects.ts';
import { MAX_CONTINUATIONS, continuationPrompt, selectedUncarried } from '../continuation.ts';

interface BuilderConfig {
  command: string;
  image: string;
  model: string;
  commandSha256: string;
  imageSha256: string;
  instructionSha256: string;
}
interface BuilderCall {
  command: string;
  room: string;
  instruction: string;
  image: string;
  evidenceDir: string;
  sessionId: string;
  model: string;
  stateRoot: string;
  storePath: string;
  parentConversationReceipt?: string | undefined;
  requestId?: string;
  prompt?: string;
}
interface BuilderDependencies {
  live: boolean;
  builder: BuilderConfig | null;
  scratch: string;
  room: string;
  here: string;
  root: string;
  runId: string;
  mode: string;
  builderStore: string;
  builderReceipt: (attempt: number) => string;
  builderLineage: (attempt: number) => Record<string, unknown>;
  canForkBuilderAttempt: (attempt: number) => boolean;
  verifyBuilderScope: (requireEntrypoints?: boolean) => void;
  clearBuilderTestArtifacts: () => void;
  candidateDigest: () => string;
  hasBuilderLaunch: (evidenceDir: string, sessionId: string, requestId: string) => boolean;
  runBuilder: (request: BuilderCall) => Promise<{ exit: number; reconciled?: boolean }>;
  audit: (
    tx: unknown,
    task: unknown,
    stage: string,
    outcome: string,
    extra: Record<string, unknown>,
  ) => Promise<unknown>;
}
interface BuilderInput {
  attempt: number;
  previousFailureKind?: string | undefined;
  previousFailureLog?: string | undefined;
  previousFailureSha256?: string | undefined;
}
type BuilderCheckpoint =
  | { phase: 'announce' }
  | { phase: 'materialize' }
  | { phase: 'maybe-continue'; continuation: number; candidateDigest: string }
  | { phase: 'continue'; continuation: number; candidateDigest: string; ids: string[] };
interface BuilderResult {
  red?: boolean;
  retryable?: boolean;
  failureLog?: string;
  failureSha256?: string;
  candidateDigest?: string;
  continuations?: number;
  remainingUncarried?: string[];
}
function legacyFailure(error: string, result: BuilderResult): TaskOutcome<BuilderResult> {
  // Existing v1 stores persist string errors; preserve their bytes at this Pi type seam.
  return { status: 'failed', error, result } as unknown as TaskOutcome<BuilderResult>;
}

export function createBuilderTask(deps: BuilderDependencies) {
  const {
    live,
    builder,
    scratch,
    room,
    here: HERE,
    root: ROOT,
    runId,
    mode,
    builderStore,
    builderReceipt,
    builderLineage,
    canForkBuilderAttempt,
    verifyBuilderScope,
    clearBuilderTestArtifacts,
    candidateDigest,
    hasBuilderLaunch,
    runBuilder,
    audit,
  } = deps;
  const ctx = BACKGROUND_CONTEXT;
  return defineTask<BuilderInput, BuilderCheckpoint, BuilderResult>({
    name: 'loyly.proto.builder',
    version: 1,
    initial: () => ({ phase: 'announce' }),
    phases: {
      announce: async (task, runtime) =>
        runtime.commit(async (tx) => {
          await audit(tx, task, task.input.attempt === 1 ? 'build' : 'repair', 'started', {
            attempt: task.input.attempt,
            session_id: `builder-${task.input.attempt}`,
            fixture: !live || builder?.model.startsWith('test/'),
            model: builder?.model ?? null,
            previous_failure_kind: task.input.previousFailureKind ?? null,
            previous_failure_log_sha256: task.input.previousFailureSha256 ?? null,
          });
          return live
            ? { status: 'running', checkpoint: { phase: 'materialize' } }
            : {
                status: 'sleeping',
                until: Date.now() + 1200,
                checkpoint: { phase: 'materialize' },
              };
        }, ctx),
      materialize: async (task, runtime) => {
        if (live) {
          const attempt = task.input.attempt;
          const sessionId = `${runId}-attempt-${attempt}`;
          let instruction = join(scratch, 'prompt.txt');
          let r: { exit: number; reconciled?: boolean } | undefined;
          let digest: string | undefined,
            reason: string | undefined,
            retryable = false;
          try {
            if (
              hash(readFileSync(instruction)) !== builder!.instructionSha256 ||
              hash(readFileSync(builder!.command)) !== builder!.commandSha256 ||
              hash(readFileSync(join(builder!.image, 'manifest.json'))) !== builder!.imageSha256
            )
              throw new Error('builder inputs changed after render');
            if (attempt > 1) {
              const log = task.input.previousFailureLog;
              if (
                !log?.startsWith(`${scratch}/`) ||
                !existsSync(log) ||
                hash(readFileSync(log)) !== task.input.previousFailureSha256 ||
                !['gate', 'builder'].includes(task.input.previousFailureKind ?? '')
              )
                throw new Error('repair evidence differs from committed receipt');
              instruction = join(scratch, `repair-${attempt}.md`);
              writeFileSync(
                instruction,
                `${readFileSync(join(scratch, 'prompt.txt'), 'utf8')}\n\n# Previous ${task.input.previousFailureKind} failure\n\nContinue the existing impl/ from the prior attempt. Repair the failure below, then run the suite and HTTP probe.\n\n${readFileSync(log, 'utf8')}\n`,
              );
            }
            r = await runBuilder({
              command: builder!.command,
              room,
              instruction,
              image: builder!.image,
              evidenceDir: join(scratch, `builder-${attempt}-evidence`),
              sessionId,
              model: builder!.model,
              stateRoot: join(ROOT, '.pi/harness/.state'),
              storePath: builderStore,
              parentConversationReceipt: attempt > 1 ? builderReceipt(attempt - 1) : undefined,
            });
            if (r.exit !== 0) {
              verifyBuilderScope(false);
              retryable = canForkBuilderAttempt(attempt);
              throw new Error(`builder host exited ${r.exit}`);
            }
            verifyBuilderScope(false);
            if (
              !existsSync(join(room, 'impl', 'start.sh')) ||
              !existsSync(join(room, 'impl', 'test.sh'))
            ) {
              retryable = canForkBuilderAttempt(attempt);
              throw new Error('builder did not leave both legacy app entrypoints');
            }
            clearBuilderTestArtifacts();
            digest = candidateDigest();
          } catch (error) {
            reason = String(error instanceof Error ? (error.stack ?? error) : error);
            writeFileSync(join(scratch, `builder-${attempt}-error.log`), `${reason}\n`);
          }
          await runtime.commit(async (tx) => {
            await audit(
              tx,
              task,
              attempt === 1 ? 'build' : 'repair',
              digest ? 'completed' : 'failed',
              {
                attempt,
                session_id: sessionId,
                candidate_digest: digest ?? null,
                instruction_sha256: existsSync(instruction)
                  ? hash(readFileSync(instruction))
                  : null,
                reconciled: r?.reconciled ?? false,
                reason_code: reason ? 'builder-effect-or-scope' : null,
                failure_log: reason ? join(scratch, `builder-${attempt}-error.log`) : null,
                failure_log_sha256: reason
                  ? hash(readFileSync(join(scratch, `builder-${attempt}-error.log`)))
                  : null,
                retryable,
                ...builderLineage(attempt),
                fixture: builder!.model.startsWith('test/'),
              },
            );
            return digest
              ? {
                  status: 'running',
                  checkpoint: { phase: 'maybe-continue', continuation: 0, candidateDigest: digest },
                }
              : {
                  status: 'terminal',
                  outcome: legacyFailure('build', {
                    retryable,
                    failureLog: join(scratch, `builder-${attempt}-error.log`),
                    failureSha256: hash(
                      readFileSync(join(scratch, `builder-${attempt}-error.log`)),
                    ),
                  }),
                };
          }, ctx);
          return;
        }
        const target = join(room, 'impl');
        rmSync(target, { recursive: true, force: true });
        mkdirSync(dirname(target), { recursive: true });
        // Tiny sauna fixture. The upstream repository has no built app to copy.
        cpSync(join(HERE, 'fixture', 'legacy-app'), target, { recursive: true });
        const red = mode === 'three-red' || task.input.attempt === 1;
        if (red) {
          writeFileSync(join(target, 'test.sh'), "#!/bin/sh\necho 'fixture red suite'\nexit 1\n");
          chmodSync(join(target, 'test.sh'), 0o755);
        }
        // An explicit fixture continuation in the same child session before the gate.
        await runtime.commit(async (tx) => {
          await audit(tx, task, 'builder-continuation', 'completed', {
            attempt: task.input.attempt,
            session_id: `builder-${task.input.attempt}`,
            remaining_uncarried: 0,
            fixture: true,
          });
          await audit(tx, task, task.input.attempt === 1 ? 'build' : 'repair', 'completed', {
            attempt: task.input.attempt,
            candidate_digest: hash(readFileSync(join(target, 'test.sh'))),
            fixture: true,
          });
          return { status: 'terminal', outcome: { status: 'completed', result: { red } } };
        }, ctx);
      },
      'maybe-continue': async (task, runtime) => {
        const { continuation, candidateDigest: before } = task.state.checkpoint;
        verifyBuilderScope();
        if (candidateDigest() !== before)
          throw new Error('candidate changed between builder turns');
        const ids = selectedUncarried(room, join(scratch, 'checklist.json'));
        await runtime.commit(async (tx) => {
          if (!ids.length || continuation >= MAX_CONTINUATIONS) {
            await audit(tx, task, 'builder-continuation', 'stopped', {
              attempt: task.input.attempt,
              session_id: `${runId}-attempt-${task.input.attempt}`,
              continuations: continuation,
              remaining_uncarried: ids,
              reason: ids.length ? 'limit' : 'all-carried',
              fixture: builder!.model.startsWith('test/'),
            });
            return {
              status: 'terminal',
              outcome: {
                status: 'completed',
                result: {
                  candidateDigest: before,
                  continuations: continuation,
                  remainingUncarried: ids,
                },
              },
            };
          }
          const next = continuation + 1;
          await audit(tx, task, 'builder-continuation', 'scheduled', {
            attempt: task.input.attempt,
            continuation: next,
            continued_ids: ids,
            candidate_before: before,
            fixture: builder!.model.startsWith('test/'),
          });
          return {
            status: 'running',
            checkpoint: { phase: 'continue', continuation: next, candidateDigest: before, ids },
          };
        }, ctx);
      },
      continue: async (task, runtime) => {
        const { continuation, candidateDigest: before, ids } = task.state.checkpoint;
        const attempt = task.input.attempt;
        const sessionId = `${runId}-attempt-${attempt}`;
        const requestId = `${sessionId}-c${continuation}`;
        const instruction = join(scratch, `continuation-${attempt}-${continuation}.md`);
        const evidenceDir = join(scratch, `builder-${attempt}-evidence`);
        let r: { exit: number; reconciled?: boolean } | undefined;
        let digest: string | undefined,
          reason: string | undefined,
          retryable = false;
        try {
          verifyBuilderScope();
          if (
            !hasBuilderLaunch(evidenceDir, sessionId, requestId) &&
            (candidateDigest() !== before ||
              JSON.stringify(selectedUncarried(room, join(scratch, 'checklist.json'))) !==
                JSON.stringify(ids))
          )
            throw new Error('candidate or uncarried list changed before continuation');
          const prompt = continuationPrompt(ids);
          if (!existsSync(instruction)) writeFileSync(instruction, prompt, { flag: 'wx' });
          if (readFileSync(instruction, 'utf8') !== prompt)
            throw new Error('continuation instruction changed after scheduling');
          if (
            hash(readFileSync(builder!.command)) !== builder!.commandSha256 ||
            hash(readFileSync(join(builder!.image, 'manifest.json'))) !== builder!.imageSha256
          )
            throw new Error('builder command or image changed before continuation');
          r = await runBuilder({
            command: builder!.command,
            room,
            instruction,
            image: builder!.image,
            evidenceDir,
            sessionId,
            requestId,
            model: builder!.model,
            stateRoot: join(ROOT, '.pi/harness/.state'),
            prompt: 'Continue this same builder session now.',
            storePath: builderStore,
            parentConversationReceipt: attempt > 1 ? builderReceipt(attempt - 1) : undefined,
          });
          if (r.exit !== 0) {
            verifyBuilderScope(false);
            retryable = canForkBuilderAttempt(attempt);
            throw new Error(`builder continuation exited ${r.exit}`);
          }
          verifyBuilderScope(false);
          if (
            !existsSync(join(room, 'impl', 'start.sh')) ||
            !existsSync(join(room, 'impl', 'test.sh'))
          ) {
            retryable = canForkBuilderAttempt(attempt);
            throw new Error('builder continuation removed a legacy app entrypoint');
          }
          clearBuilderTestArtifacts();
          digest = candidateDigest();
        } catch (error) {
          reason = String(error instanceof Error ? (error.stack ?? error) : error);
          writeFileSync(
            join(scratch, `continuation-${attempt}-${continuation}-error.log`),
            `${reason}\n`,
          );
        }
        await runtime.commit(async (tx) => {
          await audit(tx, task, 'builder-continuation', digest ? 'completed' : 'failed', {
            attempt,
            continuation,
            session_id: sessionId,
            request_id: requestId,
            continued_ids: ids,
            candidate_before: before,
            candidate_after: digest ?? null,
            instruction_sha256: existsSync(instruction) ? hash(readFileSync(instruction)) : null,
            reconciled: r?.reconciled ?? false,
            changed: digest ? digest !== before : null,
            remaining_uncarried: digest
              ? selectedUncarried(room, join(scratch, 'checklist.json'))
              : null,
            reason_code: reason ? 'builder-continuation-effect-or-scope' : null,
            failure_log: reason
              ? join(scratch, `continuation-${attempt}-${continuation}-error.log`)
              : null,
            failure_log_sha256: reason
              ? hash(
                  readFileSync(join(scratch, `continuation-${attempt}-${continuation}-error.log`)),
                )
              : null,
            retryable,
            ...builderLineage(attempt),
            fixture: builder!.model.startsWith('test/'),
          });
          if (!digest)
            return {
              status: 'terminal',
              outcome: legacyFailure('continuation', {
                retryable,
                failureLog: join(scratch, `continuation-${attempt}-${continuation}-error.log`),
                failureSha256: hash(
                  readFileSync(join(scratch, `continuation-${attempt}-${continuation}-error.log`)),
                ),
              }),
            };
          if (digest === before)
            return {
              status: 'terminal',
              outcome: {
                status: 'completed',
                result: {
                  candidateDigest: digest,
                  continuations: continuation,
                  remainingUncarried: selectedUncarried(room, join(scratch, 'checklist.json')),
                },
              },
            };
          return {
            status: 'running',
            checkpoint: { phase: 'maybe-continue', continuation, candidateDigest: digest },
          };
        }, ctx);
      },
    },
    abort: (_task, runtime) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  });
}
