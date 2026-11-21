import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineTask } from '@earendil-works/pi-durable';
import type { TaskOutcome } from '@earendil-works/pi-durable';
import { hash } from '../cycle-effects.ts';

interface GraderConfig {
  command: string;
  image: string;
  settings: string;
  model: string;
  instructionFile: string;
  instructionSha256: string;
  commandSha256: string;
  imageSha256: string;
  settingsSha256: string;
  schemaSha256: string;
}
interface GradingRoomArgs {
  out: string;
  candidateSha256: string;
  checklistSha256: string | null;
  schemaSha256: string;
  project: string;
  blindReview: boolean;
}
interface Shard {
  id: string;
  out: string;
  items: string[];
  checklistSha256: string;
}
interface Judged {
  verdicts: { id: string; verdict: string; evidence: string }[];
  pass: number;
  allureSha256: string;
}
interface GradeDependencies {
  live: boolean;
  grader: GraderConfig | null;
  here: string;
  root: string;
  scratch: string;
  gradingRoom: string;
  room: string;
  runId: string;
  schemaFile: string;
  approvedChecklistSha256: string | null;
  graderShardCount: number;
  project: string;
  blindRequired: boolean;
  attachedSchemaSha256: string;
  verifyGradingRoom: (args: GradingRoomArgs) => void;
  prepareShards: (args: {
    gradingRoom: string;
    sourceRoom: string;
    scratch: string;
    schemaFile: string;
    candidateSha256: string;
    schemaSha256: string;
    count: number;
    project: string;
    blindReview: boolean;
  }) => Shard[];
  combineShards: (args: {
    gradingRoom: string;
    shards: Shard[];
    candidateSha256: string;
    schemaSha256: string;
  }) => Judged;
  runBuilder: (request: {
    command: string;
    room: string;
    instruction: string;
    image: string;
    evidenceDir: string;
    sessionId: string;
    model: string;
    stateRoot: string;
    piSettings: string;
    prompt: string;
    roomLabel: string;
    imageAdditionsPath: string;
    readonlyInputs: boolean;
    bashTimeoutFloorSeconds: number;
    bashTimeoutCeilingSeconds: number;
  }) => Promise<{ exit: number; reconciled?: boolean }>;
  audit: (
    tx: unknown,
    task: unknown,
    stage: string,
    outcome: string,
    extra: Record<string, unknown>,
  ) => Promise<unknown>;
}

function legacyGradeFailure(): TaskOutcome<{ count: number; pass?: number }> {
  return { status: 'failed', error: 'grade' } as unknown as TaskOutcome<{
    count: number;
    pass?: number;
  }>;
}

export function createGradeTask(deps: GradeDependencies) {
  const {
    live,
    grader,
    here: HERE,
    root: ROOT,
    scratch,
    gradingRoom,
    room,
    runId,
    schemaFile,
    approvedChecklistSha256,
    graderShardCount,
    project,
    blindRequired,
    attachedSchemaSha256,
    verifyGradingRoom,
    prepareShards,
    combineShards,
    runBuilder,
    audit,
  } = deps;
  const ctx = BACKGROUND_CONTEXT;
  return defineTask<
    { candidateSha256: string | null },
    { phase: 'file' },
    { count: number; pass?: number }
  >({
    name: 'loyly.proto.grade',
    version: 1,
    initial: () => ({ phase: 'file' }),
    phases: {
      file: async (task, runtime) => {
        if (live) {
          const instruction = join(HERE, grader!.instructionFile);
          let r: { reconciled: boolean; shardCount: number } | undefined;
          let judged: Judged | undefined, reason: string | undefined;
          let shardReceipts:
            | {
                id: string;
                items: string[];
                checklist_sha256: string;
                reconciled: boolean | undefined;
              }[]
            | undefined;
          try {
            if (!grader) throw new Error('independent grader not configured');
            if (
              hash(readFileSync(instruction)) !== grader.instructionSha256 ||
              hash(readFileSync(grader.command)) !== grader.commandSha256 ||
              hash(readFileSync(join(grader.image, 'manifest.json'))) !== grader.imageSha256 ||
              hash(readFileSync(grader.settings)) !== grader.settingsSha256 ||
              attachedSchemaSha256 !== grader.schemaSha256
            )
              throw new Error(
                'grader instruction, command, image, settings or schema differs from approved digest',
              );
            verifyGradingRoom({
              out: gradingRoom,
              candidateSha256: task.input.candidateSha256!,
              checklistSha256: approvedChecklistSha256,
              schemaSha256: grader.schemaSha256,
              project,
              blindReview: blindRequired,
            });
            const shards = prepareShards({
              gradingRoom,
              sourceRoom: room,
              scratch,
              schemaFile,
              candidateSha256: task.input.candidateSha256!,
              schemaSha256: grader.schemaSha256,
              count: graderShardCount,
              project,
              blindReview: blindRequired,
            });
            const launches = await Promise.allSettled(
              shards.map((shard) =>
                runBuilder({
                  command: grader.command,
                  room: shard.out,
                  instruction,
                  image: grader.image,
                  evidenceDir: join(scratch, 'grader-evidence', shard.id),
                  sessionId: `${runId}-grade-${shard.id}`,
                  model: grader.model,
                  stateRoot: join(ROOT, '.pi/harness/.state'),
                  piSettings: grader.settings,
                  prompt:
                    'Grade your selected checklist scope now, as the attached instruction says.',
                  roomLabel: `the ${shard.id} grading room`,
                  imageAdditionsPath: '/workspace/work/image-additions.txt',
                  readonlyInputs: true,
                  bashTimeoutFloorSeconds: 300,
                  bashTimeoutCeilingSeconds: 300,
                }),
              ),
            );
            const failures = launches.flatMap((launch, i) =>
              launch.status === 'rejected'
                ? [`${shards[i]!.id}: ${launch.reason}`]
                : launch.value.exit !== 0
                  ? [`${shards[i]!.id}: exit ${launch.value.exit}`]
                  : [],
            );
            if (failures.length) throw new Error(`grader shards failed: ${failures.join('; ')}`);
            const successful = launches.map((launch) => {
              if (launch.status !== 'fulfilled') throw new Error('grader shard lost its result');
              return launch.value;
            });
            verifyGradingRoom({
              out: gradingRoom,
              candidateSha256: task.input.candidateSha256!,
              checklistSha256: approvedChecklistSha256,
              schemaSha256: grader.schemaSha256,
              project,
              blindReview: blindRequired,
            });
            judged = combineShards({
              gradingRoom,
              shards,
              candidateSha256: task.input.candidateSha256!,
              schemaSha256: grader.schemaSha256,
            });
            shardReceipts = shards.map((shard, i) => ({
              id: shard.id,
              items: shard.items,
              checklist_sha256: shard.checklistSha256,
              reconciled: successful[i]?.reconciled,
            }));
            r = {
              reconciled: successful.some((launch) => launch.reconciled),
              shardCount: shards.length,
            };
            writeFileSync(join(scratch, 'verdicts.json'), JSON.stringify(judged.verdicts));
            cpSync(join(gradingRoom, 'work', 'surprises.json'), join(scratch, 'surprises.json'));
          } catch (error) {
            reason = String(error instanceof Error ? (error.stack ?? error) : error);
            writeFileSync(join(scratch, 'grade-error.log'), `${reason}\n`);
          }
          await runtime.commit(async (tx) => {
            await audit(tx, task, 'grade', judged ? 'completed' : 'failed', {
              model: grader?.model ?? null,
              fixture: grader?.model.startsWith('test/') ?? false,
              item_count: judged?.verdicts.length ?? 0,
              pass_count: judged?.pass ?? 0,
              shard_count: r?.shardCount ?? 0,
              shards: shardReceipts ?? [],
              allure_results_sha256: judged?.allureSha256 ?? null,
              schema_sha256: grader?.schemaSha256 ?? null,
              verdicts_sha256: judged ? hash(readFileSync(join(scratch, 'verdicts.json'))) : null,
              surprises_sha256: judged ? hash(readFileSync(join(scratch, 'surprises.json'))) : null,
              reconciled: r?.reconciled ?? false,
              reason_code: reason ? 'grader-effect-or-verdict' : null,
            });
            return {
              status: 'terminal',
              outcome: judged
                ? {
                    status: 'completed',
                    result: { count: judged.verdicts.length, pass: judged.pass },
                  }
                : legacyGradeFailure(),
            };
          }, ctx);
          return;
        }
        // Independent grader task is a deterministic fixture. The legacy score and
        // scoreboard below are real; no grader claim is treated as a gate verdict.
        const selected = readFileSync(join(gradingRoom, 'checklist.txt'), 'utf8')
          .trim()
          .split('\n')
          .map((id) => ({ id }));
        const verdicts = selected.map((item) => ({
          id: item.id,
          verdict: item.id === '01-010' ? 'fail' : 'pass',
          evidence: `prototype fixture grader observed ${item.id}`,
        }));
        writeFileSync(join(scratch, 'verdicts.json'), JSON.stringify(verdicts));
        await runtime.commit(async (tx) => {
          await audit(tx, task, 'grade', 'completed', {
            fixture: true,
            item_count: verdicts.length,
            fail_count: verdicts.filter((v) => v.verdict === 'fail').length,
            verdicts_sha256: hash(readFileSync(join(scratch, 'verdicts.json'))),
          });
          return {
            status: 'terminal',
            outcome: { status: 'completed', result: { count: verdicts.length } },
          };
        }, ctx);
      },
    },
    abort: (_task, runtime) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  });
}
