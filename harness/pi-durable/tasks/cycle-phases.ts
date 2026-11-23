// @ts-nocheck
// Cycle phase handlers extracted from createCycleTask so each phase keeps a
// bounded cyclomatic complexity. Durable checkpoint shapes stay unchanged.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  finalVerdictsFromBlindReview,
  prepareBlindReview,
  probeBlindAnswer,
  verifyBlindReviewPacket,
  writeBlindAgentAllure,
} from '../blind-review.ts';
import { runBlindAgent } from '../blind-agent-adapter.mjs';
import { bindScoreInput, verifyScoredCycle } from '../score-receipt.ts';
import { prepareGradingRoom, verifyGradingRoom } from '../grading-room.ts';
import {
  genChecklist,
  MeasureRefuse,
  scoreCycle,
  scoreboard as writeScoreboard,
} from '../measure/index.ts';
import { runDurablePanelReport } from '../panel-adapter.ts';
import { hash } from '../cycle-effects.ts';
import { BLIND_ITEM_ID, BLIND_SPEC_RELATIVE, BOOKING_SLICE } from '../project/loyly/index.ts';
import { terminalFail, type CycleDependencies } from './cycle-types.ts';

function measureLog(
  scratch: string,
  name: string,
  run: () => { stdout?: string; stderr?: string },
) {
  try {
    const result = run();
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    writeFileSync(join(scratch, `${name}.log`), output);
    return { code: 0, output, sha256: hash(output) };
  } catch (cause: unknown) {
    const message =
      cause instanceof MeasureRefuse || cause instanceof Error
        ? cause.message
        : String(cause);
    const output = `${message}\n`;
    writeFileSync(join(scratch, `${name}.log`), output);
    return { code: 1, output, sha256: hash(output) };
  }
}

function phaseCut(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    let r = { code: 0, sha256: hash('original source: no cut requested') };
    if (approvedCommit && !proveCut()) {
      if (existsSync(cut)) throw new Error('incomplete or changed original-source cut');
      mkdirSync(cut, { recursive: true });
      r = command(
        'cut-clone',
        'git',
        ['clone', '-q', '--no-local', '--no-checkout', approvedSourceRepo, sourceRoot],
        { cwd: ROOT },
      );
      if (r.code === 0)
        r = command('cut-checkout', 'git', ['checkout', '-q', '--detach', approvedCommit], {
          cwd: sourceRoot,
        });
      if (
        r.code === 0 &&
        gitAt(sourceRoot, 'rev-parse', 'HEAD') === approvedCommit &&
        gitAt(sourceRoot, 'status', '--porcelain') === ''
      )
        writeFileSync(
          join(cut, 'cut.json'),
          JSON.stringify({
            commit: approvedCommit,
            project: sourceRoot,
            source_repo: approvedSourceRepo,
          }),
        );
      if (!proveCut()) r = { ...r, code: 1 };
    }
    await runtime.commit(async (tx) => {
      await audit(tx, task, 'cut', r.code === 0 ? 'pinned' : 'failed', {
        approved_commit: approvedCommit ?? null,
        source_root: sourceRoot,
        log_sha256: r.sha256,
      });
      return r.code === 0
        ? { status: 'running', checkpoint: { phase: 'preflight' } }
        : terminalFail('cut');
    }, ctx);
  };
}

function phasePreflight(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    const r = command('preflight', 'bash', ['harness/check.sh', '--local']);
    await runtime.commit(async (tx) => {
      await audit(tx, task, 'self-check', r.code === 0 ? 'passed' : 'failed', {
        log_sha256: r.sha256,
      });
      return r.code === 0
        ? { status: 'running', checkpoint: { phase: 'fence' } }
        : terminalFail('self-check');
    }, ctx);
  };
}

function phaseFence(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    let r;
    if (proofOfFence())
      r = { code: 0, output: 'fence OK: reconciled', sha256: hash('fence OK: reconciled') };
    else r = command('fence', 'bash', ['harness/fence.sh', room]);
    await runtime.commit(async (tx) => {
      await audit(tx, task, 'fence', r.code === 0 ? 'passed' : 'failed', {
        room,
        log_sha256: r.sha256,
      });
      return r.code === 0
        ? { status: 'running', checkpoint: { phase: 'checklist' } }
        : terminalFail('fence');
    }, ctx);
  };
}

function phaseChecklist(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    const r = measureLog(scratch, 'checklist', () => {
      const result = genChecklist({
        root: sourceRoot,
        out: join(scratch, 'checklist.json'),
      });
      return { stdout: '', stderr: result.stderr };
    });
    const n =
      r.code === 0
        ? JSON.parse(readFileSync(join(scratch, 'checklist.json'), 'utf8')).items.length
        : 0;
    const actual = r.code === 0 ? hash(readFileSync(join(scratch, 'checklist.json'))) : null;
    const approved = !approvedCommit || actual === approvedChecklistSha256;
    await runtime.commit(async (tx) => {
      await audit(tx, task, 'checklist', r.code === 0 && approved ? 'derived' : 'refused', {
        item_count: n,
        checklist_sha256: actual,
        approved_sha256: approvedChecklistSha256,
        log_sha256: r.sha256,
      });
      return r.code === 0 && approved
        ? { status: 'running', checkpoint: { phase: 'render' } }
        : terminalFail('checklist');
    }, ctx);
  };
}

function phaseRender(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    // The original harness has no prompt renderer. Record the exact legacy
    // README and plan the fixture builder would receive, without inventing a v2 tool.
    const plan = live
      ? null
      : readFileSync(join(sourceRoot, 'docs', 'plan', BOOKING_SLICE, 'spec.feature'), 'utf8');
    const instruction = live
      ? readFileSync(join(HERE, builder.instructionFile), 'utf8')
      : `${readFileSync(join(sourceRoot, 'harness', 'README.md'), 'utf8')}\n\n${plan}`;
    const commandSha256 =
      live && existsSync(builder.command) ? hash(readFileSync(builder.command)) : null;
    const manifest = live ? join(builder.image, 'manifest.json') : null;
    const imageSha256 = manifest && existsSync(manifest) ? hash(readFileSync(manifest)) : null;
    const instructionSha256 = hash(instruction);
    const approved =
      !live ||
      (instructionSha256 === builder.instructionSha256 &&
        commandSha256 === builder.commandSha256 &&
        imageSha256 === builder.imageSha256);
    if (approved) writeFileSync(join(scratch, 'prompt.txt'), instruction);
    await runtime.commit(async (tx) => {
      await audit(tx, task, 'render', approved ? 'completed' : 'refused', {
        instruction_sha256: instructionSha256,
        approved_instruction_sha256: builder?.instructionSha256 ?? null,
        builder_command_sha256: commandSha256,
        approved_command_sha256: builder?.commandSha256 ?? null,
        builder_image_sha256: imageSha256,
        approved_image_sha256: builder?.imageSha256 ?? null,
        model: builder?.model ?? null,
      });
      return approved
        ? {
            status: 'running',
            checkpoint: { phase: 'build', attempt: 1, previousGateLog: null },
          }
        : terminalFail('render');
    }, ctx);
  };
}

function phaseBuild(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) =>
    runtime.commit(async (tx) => {
      const { attempt, previousFailureLog, previousFailureSha256, previousFailureKind } =
        task.state.checkpoint;
      const id = await tx.createTask(
        Builder,
        { attempt, previousFailureLog, previousFailureSha256, previousFailureKind },
        { ownership: { kind: 'task', taskId: task.id } },
      );
      return {
        status: 'waiting',
        checkpoint: { phase: 'after-build', attempt, builder: id },
        on: [id],
        policy: 'failFast',
      };
    }, ctx);
}

function phaseAfterBuild(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    const { attempt, builder } = task.state.checkpoint;
    const [outcome] = await runtime.outcomes([builder], ctx);
    await runtime.commit(async (tx) => {
      const decision = lifecycle.afterBuild(attempt, outcome);
      if (decision.retry === 'builder') {
        await audit(tx, task, 'retry', 'scheduled', {
          attempt: decision.attempt,
          previous_builder_log: decision.failureLog,
          previous_builder_log_sha256: decision.failureSha256,
          fork_from: builderReceipt(attempt),
        });
        return {
          status: 'running',
          checkpoint: {
            phase: 'build',
            attempt: decision.attempt,
            previousFailureLog: decision.failureLog,
            previousFailureSha256: decision.failureSha256,
            previousFailureKind: 'builder',
          },
        };
      }
      if (decision.terminal) {
        await audit(tx, task, 'cycle', 'failed', { reason: decision.reason, attempt });
        if (decision.exhausted)
          return {
            status: 'terminal',
            outcome: { status: 'completed', result: { passed: false, attempts: attempt } },
          };
        return terminalFail('build');
      }
      return { status: 'running', checkpoint: { phase: decision.phase, attempt } };
    }, ctx);
  };
}

function phaseGate(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) =>
    runtime.commit(async (tx) => {
      const { attempt } = task.state.checkpoint;
      const id = await tx.createTask(
        Gate,
        { attempt },
        { ownership: { kind: 'task', taskId: task.id } },
      );
      return {
        status: 'waiting',
        checkpoint: { phase: 'after-gate', attempt, gate: id },
        on: [id],
        policy: 'failFast',
      };
    }, ctx);
}

function phaseAfterGate(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    const { attempt, gate } = task.state.checkpoint;
    const [outcome] = await runtime.outcomes([gate], ctx);
    await runtime.commit(async (tx) => {
      const decision = lifecycle.afterGate(attempt, outcome);
      if (decision.reason === 'gate-effect-failed') {
        await audit(tx, task, 'cycle', 'failed', { reason: decision.reason, attempt });
        return terminalFail('gate');
      }
      if (decision.phase === 'grading-room') {
        return {
          status: 'running',
          checkpoint: {
            phase: decision.phase,
            attempt,
            candidateSha256: decision.candidateSha256,
          },
        };
      }
      if (decision.retry === 'gate') {
        await audit(tx, task, 'retry', 'scheduled', {
          attempt: decision.attempt,
          previous_gate_log: decision.failureLog,
        });
        return {
          status: 'running',
          checkpoint: {
            phase: 'build',
            attempt: decision.attempt,
            previousFailureLog: decision.failureLog,
            previousFailureSha256: decision.failureSha256,
            previousFailureKind: 'gate',
          },
        };
      }
      await audit(tx, task, 'cycle', 'failed', { reason: decision.reason, attempt });
      return {
        status: 'terminal',
        outcome: { status: 'completed', result: { passed: false, attempts: attempt } },
      };
    }, ctx);
  };
}

function phaseGradingRoom(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    if (live) {
      const candidateSha256 = task.state.checkpoint.candidateSha256;
      const checklistFile = join(scratch, 'checklist.json');
      const args = {
        sourceRoom: room,
        candidateRoom: room,
        checklistFile,
        schemaFile,
        out: gradingRoom,
        candidateSha256,
        checklistSha256: approvedChecklistSha256,
        schemaSha256: grader?.schemaSha256 ?? attachedSchemaSha256,
        project,
        blindReview: blindRequired,
      };
      let reason: string | undefined;
      try {
        if (existsSync(gradingRoom)) verifyGradingRoom(args);
        else prepareGradingRoom(args);
      } catch (error: unknown) {
        reason = String(error instanceof Error ? (error.stack ?? error) : error);
        writeFileSync(join(scratch, 'grading-room-error.log'), `${reason}\n`);
      }
      await runtime.commit(async (tx) => {
        await audit(tx, task, 'grading-room', reason ? 'failed' : 'prepared', {
          candidate_sha256: candidateSha256,
          checklist_sha256: approvedChecklistSha256,
          reason_code: reason ? 'grading-room-copy' : null,
        });
        if (!reason && !grader)
          await audit(tx, task, 'grade', 'blocked', {
            reason: 'independent-live-grader-not-connected',
          });
        if (reason || !grader)
          return {
            status: 'terminal',
            outcome: {
              status: 'failed',
              error: reason ? 'grading-room' : 'grader-not-connected',
            },
          };
        return {
          status: 'running',
          checkpoint: {
            phase: 'grade',
            attempt: task.state.checkpoint.attempt,
            candidateSha256,
          },
        };
      }, ctx);
      return;
    }
    let r;
    if (existsSync(join(gradingRoom, '.grading-room.txt'))) {
      r = { code: 0, sha256: hash(readFileSync(join(gradingRoom, '.grading-room.txt'))) };
    } else {
      mkdirSync(gradingRoom, { recursive: true });
      cpSync(join(room, 'impl'), join(gradingRoom, 'impl'), { recursive: true });
      cpSync(join(room, 'docs', 'plan'), join(gradingRoom, 'plan'), { recursive: true });
      const ids = JSON.parse(readFileSync(join(scratch, 'checklist.json'), 'utf8')).items.map(
        (item) => item.id,
      );
      writeFileSync(join(gradingRoom, 'checklist.txt'), `${ids.join('\n')}\n`);
      const receipt = `legacy fixture grader view; items=${ids.length}\n`;
      writeFileSync(join(gradingRoom, '.grading-room.txt'), receipt);
      r = { code: 0, sha256: hash(receipt) };
    }
    await runtime.commit(async (tx) => {
      await audit(tx, task, 'grading-room', r.code === 0 ? 'prepared' : 'failed', {
        log_sha256: r.sha256,
      });
      return r.code === 0
        ? {
            status: 'running',
            checkpoint: { phase: 'grade', attempt: task.state.checkpoint.attempt },
          }
        : terminalFail('grading-room');
    }, ctx);
  };
}

function phaseGrade(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) =>
    runtime.commit(async (tx) => {
      const id = await tx.createTask(
        Grade,
        { candidateSha256: task.state.checkpoint.candidateSha256 ?? null },
        { ownership: { kind: 'task', taskId: task.id } },
      );
      return {
        status: 'waiting',
        checkpoint: {
          phase: 'after-grade',
          grader: id,
          attempt: task.state.checkpoint.attempt,
        },
        on: [id],
        policy: 'failFast',
      };
    }, ctx);
}

function phaseAfterGrade(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    const [outcome] = await runtime.outcomes([task.state.checkpoint.grader], ctx);
    await runtime.commit(async (tx) => {
      const decision = lifecycle.afterGrade(outcome);
      if (decision.terminal) {
        await audit(tx, task, 'cycle', 'failed', { reason: decision.reason });
        return terminalFail('grade');
      }
      return {
        status: 'running',
        checkpoint: { phase: decision.phase, attempt: task.state.checkpoint.attempt },
      };
    }, ctx);
  };
}

function phaseBlindReview(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    const packetDir = join(scratch, 'blind-agent-packet');
    const reviewFile = join(scratch, 'blind-agent-review.json');
    const requestFile = join(scratch, 'blind-agent-request.json');
    const verificationDir = join(scratch, 'blind-agent-verification');
    const allureDir = join(scratch, 'blind-agent-allure');
    let packetSha256: string | undefined;
    let projected:
      { verdicts: unknown[]; rawAllureSha256?: string; reviewSha256?: string } | undefined;
    let reason: string | undefined;
    let agentLaunch:
      | {
          review: Record<string, unknown> & {
            launch_receipt_sha256?: string;
            verdict?: string;
          };
          request?: unknown;
          reconciled?: boolean;
        }
      | undefined;
    try {
      if (!existsSync(packetDir)) prepareBlindReview({ gradingRoom, out: packetDir });
      packetSha256 = verifyBlindReviewPacket({ packetDir, gradingRoom }).packetSha256;
      if (blindAgent) {
        agentLaunch = await runBlindAgent({
          packetDir,
          gradingRoom,
          room: join(scratch, 'blind-agent-room'),
          instruction: join(HERE, blindAgent.instructionFile),
          command: blindAgent.command,
          image: blindAgent.image,
          settings: blindAgent.settings,
          model: blindAgent.model,
          evidenceDir: join(scratch, 'blind-agent-evidence'),
          stateRoot: join(ROOT, '.pi/harness/.state'),
          sessionId: `${runId}-blind-011`,
          instructionSha256: blindAgent.instructionSha256,
          commandSha256: blindAgent.commandSha256,
          imageSha256: blindAgent.imageSha256,
          settingsSha256: blindAgent.settingsSha256,
        });
        const expected = agentLaunch.review;
        if (existsSync(reviewFile)) {
          const existing = JSON.parse(readFileSync(reviewFile, 'utf8'));
          for (const key of Object.keys(expected))
            if (
              key !== 'reviewed_at' &&
              JSON.stringify(existing[key]) !== JSON.stringify(expected[key])
            )
              throw new Error(`blind agent response changed after launch: ${key}`);
        } else {
          if (agentLaunch.request) {
            writeFileSync(`${requestFile}.partial`, `${JSON.stringify(agentLaunch.request)}\n`);
            renameSync(`${requestFile}.partial`, requestFile);
          }
          writeFileSync(`${reviewFile}.partial`, `${JSON.stringify(expected)}\n`);
          renameSync(`${reviewFile}.partial`, reviewFile);
        }
        if (
          agentLaunch.request &&
          JSON.stringify(JSON.parse(readFileSync(requestFile, 'utf8'))) !==
            JSON.stringify(agentLaunch.request)
        )
          throw new Error('blind agent request changed after launch');
        if (!agentLaunch.request && existsSync(requestFile))
          throw new Error('unusable blind answer must not supply an HTTP request');
      }
      if (
        !existsSync(reviewFile) ||
        (existsSync(reviewFile) &&
          JSON.parse(readFileSync(reviewFile, 'utf8')).verdict === 'pass' &&
          !existsSync(requestFile))
      ) {
        await runtime.commit(async (tx) => {
          if (task.state.checkpoint.packetSha256 !== packetSha256)
            await audit(tx, task, 'blind-review', 'awaiting', {
              packet_sha256: packetSha256,
              candidate_sha256: candidateDigest(gradingRoom),
              spec_sha256: hash(readFileSync(join(gradingRoom, BLIND_SPEC_RELATIVE))),
            });
          return {
            status: 'sleeping',
            until: Date.now() + 5000,
            checkpoint: { ...task.state.checkpoint, packetSha256 },
          };
        }, ctx);
        return;
      }
      const review = JSON.parse(readFileSync(reviewFile, 'utf8'));
      if (review.verdict === 'pass' && !existsSync(verificationDir))
        await probeBlindAnswer({
          packetDir,
          reviewFile,
          gradingRoom,
          request: JSON.parse(readFileSync(requestFile, 'utf8')),
          out: verificationDir,
        });
      writeBlindAgentAllure({
        packetDir,
        reviewFile,
        gradingRoom,
        verificationDir: review.verdict === 'pass' ? verificationDir : undefined,
        out: allureDir,
      });
      projected = finalVerdictsFromBlindReview({
        packetDir,
        reviewFile,
        gradingRoom,
        verificationDir: review.verdict === 'pass' ? verificationDir : undefined,
        out: allureDir,
      });
      const finalFile = join(scratch, 'final-verdicts.json');
      const bytes = JSON.stringify(projected.verdicts);
      if (existsSync(finalFile) && readFileSync(finalFile, 'utf8') !== bytes)
        throw new Error('final verdicts differ from the previously projected review');
      if (!existsSync(finalFile)) writeFileSync(finalFile, bytes);
    } catch (error: unknown) {
      reason = String(error instanceof Error ? (error.stack ?? error) : error);
      writeFileSync(join(scratch, 'blind-review-error.log'), `${reason}\n`);
    }
    await runtime.commit(async (tx) => {
      await audit(tx, task, 'blind-review', projected ? 'completed' : 'failed', {
        packet_sha256: packetSha256 ?? null,
        raw_allure_sha256: projected?.rawAllureSha256 ?? null,
        review_sha256: projected?.reviewSha256 ?? null,
        agent_launch_receipt_sha256: agentLaunch?.review.launch_receipt_sha256 ?? null,
        agent_reconciled: agentLaunch?.reconciled ?? false,
        final_verdicts_sha256: projected
          ? hash(readFileSync(join(scratch, 'final-verdicts.json')))
          : null,
        reason_code: reason ? 'blind-agent-evidence' : null,
      });
      return projected
        ? {
            status: 'running',
            checkpoint: {
              phase: lifecycle.afterAssessment('blind-review', true).phase,
              attempt: task.state.checkpoint.attempt,
            },
          }
        : terminalFail('blind-review');
    }, ctx);
  };
}

function phasePanel(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) =>
    runtime.commit(async (tx) => {
      const id = await tx.createTask(
        Panel,
        { candidateSha256: candidateDigest(room) },
        { ownership: { kind: 'task', taskId: task.id } },
      );
      return {
        status: 'waiting',
        checkpoint: { phase: 'after-panel', panel: id, attempt: task.state.checkpoint.attempt },
        on: [id],
        policy: 'failFast',
      };
    }, ctx);
}

function phaseAfterPanel(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    const [outcome] = await runtime.outcomes([task.state.checkpoint.panel], ctx);
    await runtime.commit(async (tx) => {
      if (outcome?.status !== 'completed') {
        await audit(tx, task, 'cycle', 'failed', { reason: 'panel-vm-effect' });
        return terminalFail('panel');
      }
      return {
        status: 'running',
        checkpoint: {
          phase: lifecycle.afterAssessment('panel', true).phase,
          attempt: task.state.checkpoint.attempt,
        },
      };
    }, ctx);
  };
}

function phaseScore(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    const verdictsFile = join(scratch, blindRequired ? 'final-verdicts.json' : 'verdicts.json');
    let r;
    let board;
    let scoreReceipt:
      { items: { id: string; verdict: string }[]; score: string; scoreSha256: string } | undefined;
    let scoreInput: unknown;
    let reason: string | undefined;
    let reconciled = false;
    try {
      const candidateSha256 = candidateDigest(room);
      if (live && blindRequired) {
        verifyGradingRoom({
          out: gradingRoom,
          candidateSha256,
          checklistSha256: approvedChecklistSha256,
          schemaSha256: grader.schemaSha256,
          project,
          blindReview: blindRequired,
        });
        const reviewFile = join(scratch, 'blind-agent-review.json');
        const review = JSON.parse(readFileSync(reviewFile, 'utf8'));
        const projected = finalVerdictsFromBlindReview({
          packetDir: join(scratch, 'blind-agent-packet'),
          reviewFile,
          gradingRoom,
          verificationDir:
            review.verdict === 'pass' ? join(scratch, 'blind-agent-verification') : undefined,
          out: join(scratch, 'blind-agent-allure'),
        });
        if (JSON.stringify(projected.verdicts) !== readFileSync(verdictsFile, 'utf8'))
          throw new Error('final verdicts changed after blind review');
      }
      if (!existsSync(instrument)) {
        const cloned = command('instrument-clone', 'git', [
          'clone',
          '-q',
          '--depth',
          '1',
          `file://${sourceRoot}`,
          instrument,
        ]);
        if (cloned.code !== 0) throw new Error('instrument clone failed');
      }
      scoreInput = bindScoreInput({
        scratch,
        sourceRoot,
        instrument,
        candidateSha256,
        verdictsFile,
        scoreCycle,
      });
      const cycleDir = join(instrument, 'harness', 'cycles', scoreCycle);
      mkdirSync(cycleDir, { recursive: true });
      if (!existsSync(join(cycleDir, 'checklist.json'))) {
        const checklist = measureLog(scratch, 'score-checklist', () => {
          const result = genChecklist({
            root: instrument,
            out: join(cycleDir, 'checklist.json'),
          });
          return { stdout: '', stderr: result.stderr };
        });
        if (checklist.code !== 0) throw new Error('score checklist derivation failed');
      }
      if (existsSync(join(cycleDir, 'scores.json'))) {
        scoreReceipt = verifyScoredCycle({
          scratch,
          instrument,
          verdictsFile,
          cycle: scoreCycle,
        });
        r = { code: 0, sha256: scoreReceipt.scoreSha256 };
        reconciled = true;
      } else {
        r = measureLog(scratch, 'score', () => {
          const result = scoreCycle({
            root: instrument,
            cycle: scoreCycle,
            verdictsPath: verdictsFile,
          });
          return { stdout: result.stdout, stderr: '' };
        });
        if (r.code !== 0) throw new Error('legacy scorer failed');
        scoreReceipt = verifyScoredCycle({
          scratch,
          instrument,
          verdictsFile,
          cycle: scoreCycle,
        });
      }
      board = measureLog(scratch, 'scoreboard', () => {
        const result = writeScoreboard({ root: instrument, cycle: scoreCycle });
        return { stdout: result.text, stderr: '' };
      });
      if (board.code !== 0) throw new Error('legacy scoreboard failed');
    } catch (error: unknown) {
      reason = String(error instanceof Error ? (error.stack ?? error) : error);
      writeFileSync(join(scratch, 'score-error.log'), `${reason}\n`);
    }
    const scored = scoreReceipt?.items ?? [];
    const score = scoreReceipt?.score ?? null;
    const blindAgentReviewFailed =
      blindRequired && scored.some((item) => item.id === BLIND_ITEM_ID && item.verdict === 'fail');
    const attempt = task.state.checkpoint.attempt ?? 2;
    await runtime.commit(async (tx) => {
      await audit(tx, task, 'score', reason ? 'failed' : 'filed', {
        log_sha256: r?.sha256 ?? null,
        score_input_sha256: scoreInput
          ? hash(readFileSync(join(scratch, 'score-input.json')))
          : null,
        score_file_sha256: scoreReceipt?.scoreSha256 ?? null,
        reconciled,
        fixture_grader: !live || grader?.model.startsWith('test/'),
      });
      if (!reason)
        await audit(tx, task, 'scoreboard', 'reported', {
          cycle: scoreCycle,
          log_sha256: board.sha256,
        });
      if (reason) {
        await audit(tx, task, 'cycle', 'failed', { reason: 'score' });
        return terminalFail('score');
      }
      if (panel)
        return {
          status: 'running',
          checkpoint: { phase: 'panel-report', attempt, score, blindAgentReviewFailed },
        };
      await audit(tx, task, 'cycle', live ? 'measured' : 'completed', {
        reason: blindAgentReviewFailed ? 'blind-agent-review-failed' : null,
      });
      return {
        status: 'terminal',
        outcome: {
          status: 'completed',
          result: {
            passed: !live,
            scored: true,
            blindAgentReviewFailed,
            attempts: attempt,
            score,
          },
        },
      };
    }, ctx);
  };
}

function phasePanelReport(deps: CycleDependencies, ctx) {
  const {
    lifecycle,
    audit,
    command,
    proveCut,
    proofOfFence,
    gitAt,
    candidateDigest,
    builderReceipt,
    Builder,
    Gate,
    Grade,
    Panel,
    cut,
    sourceRoot,
    room,
    scratch,
    gradingRoom,
    instrument,
    here: HERE,
    root: ROOT,
    runId,
    approvedCommit,
    approvedSourceRepo,
    approvedChecklistSha256,
    live,
    builder,
    grader,
    blindAgent,
    blindRequired,
    project,
    panel,
    scoreCycle,
    schemaFile,
    attachedSchemaSha256,
  } = deps;
  return async (task, runtime) => {
    let report:
      { out: string; reconciled?: boolean; summary: { panel_outcome: string } } | undefined;
    let reason: string | undefined;
    try {
      const selected = JSON.parse(readFileSync(join(scratch, 'panel-vm', 'selected.json'), 'utf8'));
      const specialists = join(
        scratch,
        'panel-vm',
        `attempt-${String(selected.attempt).padStart(2, '0')}`,
      );
      report = await runDurablePanelReport({
        scratch,
        specialists,
        planFile: join(HERE, panel.planFile),
      });
    } catch (error: unknown) {
      reason = String(error instanceof Error ? (error.stack ?? error) : error);
      writeFileSync(join(scratch, 'panel-report-error.log'), `${reason}\n`);
    }
    await runtime.commit(async (tx) => {
      await audit(tx, task, 'panel-report', report ? 'completed' : 'failed', {
        manifest_sha256: report
          ? hash(readFileSync(join(report.out, 'panel-manifest.json')))
          : null,
        plan_sha256: panel.planSha256,
        score: task.state.checkpoint.score,
        panel_outcome: report?.summary.panel_outcome ?? null,
        reconciled: report?.reconciled ?? false,
        reason_code: reason ? 'panel-report-effect' : null,
      });
      if (!report) {
        await audit(tx, task, 'cycle', 'failed', { reason: 'panel-report-effect' });
        return terminalFail('panel-report');
      }
      const { attempt, score, blindAgentReviewFailed } = task.state.checkpoint;
      await audit(tx, task, 'cycle', 'measured', {
        reason: blindAgentReviewFailed ? 'blind-agent-review-failed' : null,
        panel_outcome: report.summary.panel_outcome,
      });
      return {
        status: 'terminal',
        outcome: {
          status: 'completed',
          result: {
            passed: false,
            scored: true,
            blindAgentReviewFailed,
            attempts: attempt,
            score,
            panelOutcome: report.summary.panel_outcome,
          },
        },
      };
    }, ctx);
  };
}

export function createCyclePhases(deps: CycleDependencies, ctx) {
  return {
    cut: phaseCut(deps, ctx),
    preflight: phasePreflight(deps, ctx),
    fence: phaseFence(deps, ctx),
    checklist: phaseChecklist(deps, ctx),
    render: phaseRender(deps, ctx),
    build: phaseBuild(deps, ctx),
    'after-build': phaseAfterBuild(deps, ctx),
    gate: phaseGate(deps, ctx),
    'after-gate': phaseAfterGate(deps, ctx),
    'grading-room': phaseGradingRoom(deps, ctx),
    grade: phaseGrade(deps, ctx),
    'after-grade': phaseAfterGrade(deps, ctx),
    'blind-review': phaseBlindReview(deps, ctx),
    panel: phasePanel(deps, ctx),
    'after-panel': phaseAfterPanel(deps, ctx),
    score: phaseScore(deps, ctx),
    'panel-report': phasePanelReport(deps, ctx),
  };
}
