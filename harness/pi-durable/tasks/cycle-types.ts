// @ts-nocheck
// Shared Cycle dependency and checkpoint shapes.
import type { TaskId, TaskOutcome } from '@earendil-works/pi-durable';

interface CommandResult {
  code: number;
  output?: string;
  sha256: string;
  log?: string;
}

interface CycleLifecycle {
  afterBuild: (
    attempt: number,
    outcome: unknown,
  ) => {
    retry?: string;
    terminal?: boolean;
    exhausted?: boolean;
    phase?: string;
    attempt?: number;
    failureLog?: string;
    failureSha256?: string;
    reason?: string;
  };
  afterGate: (
    attempt: number,
    outcome: unknown,
  ) => {
    reason?: string;
    phase?: string;
    retry?: string;
    attempt?: number;
    failureLog?: string;
    failureSha256?: string;
    candidateSha256?: string;
  };
  afterGrade: (outcome: unknown) => {
    terminal?: boolean;
    reason?: string;
    phase?: string;
  };
  afterAssessment: (stage: string, ok: boolean) => { phase: string };
}

interface AgentConfig {
  command: string;
  image: string;
  settings?: string;
  model: string;
  instructionFile: string;
  instructionSha256: string;
  commandSha256: string;
  imageSha256: string;
  settingsSha256?: string;
  schemaSha256?: string;
}

interface PanelConfig {
  planFile: string;
  planSha256: string;
  image: string;
  imageSha256: string;
}

interface CycleDependencies {
  lifecycle: CycleLifecycle;
  audit: (
    tx: unknown,
    task: unknown,
    stage: string,
    outcome: string,
    extra?: Record<string, unknown>,
  ) => Promise<unknown>;
  command: (
    name: string,
    program: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
  ) => CommandResult;
  proveCut: () => boolean;
  proofOfFence: () => boolean;
  gitAt: (path: string, ...args: string[]) => string | null;
  candidateDigest: (room?: string) => string;
  builderReceipt: (attempt: number) => string;
  // Child task definitions from defineTask; Pi owns the concrete type.
  Builder: any;
  Gate: any;
  Grade: any;
  Panel: any;
  cut: string;
  sourceRoot: string;
  room: string;
  scratch: string;
  gradingRoom: string;
  instrument: string;
  here: string;
  root: string;
  runId: string;
  approvedCommit: string | undefined;
  approvedSourceRepo: string;
  approvedChecklistSha256: string | null;
  live: boolean;
  builder: AgentConfig | null;
  grader:
    | (AgentConfig & {
        schemaSha256: string;
        settings: string;
        settingsSha256: string;
      })
    | null;
  blindAgent: (AgentConfig & { settings: string; settingsSha256: string }) | null;
  blindRequired: boolean;
  project: string;
  panel: PanelConfig | null;
  scoreCycle: string;
  schemaFile: string;
  attachedSchemaSha256: string;
}

type CycleResult = Record<string, unknown>;

function terminalFail(error: string) {
  return {
    status: 'terminal' as const,
    outcome: { status: 'failed' as const, error } as unknown as TaskOutcome<CycleResult>,
  };
}

export type { CommandResult, PanelConfig, CycleDependencies };
export { terminalFail };
