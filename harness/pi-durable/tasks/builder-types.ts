// @ts-nocheck
import type { TaskOutcome } from '@earendil-works/pi-durable';

export interface BuilderConfig {
  command: string;
  image: string;
  model: string;
  commandSha256: string;
  imageSha256: string;
  instructionSha256: string;
}
export interface BuilderCall {
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
export interface BuilderDependencies {
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
export interface BuilderInput {
  attempt: number;
  previousFailureKind?: string | undefined;
  previousFailureLog?: string | undefined;
  previousFailureSha256?: string | undefined;
}
export type BuilderCheckpoint =
  | { phase: 'announce' }
  | { phase: 'materialize' }
  | { phase: 'maybe-continue'; continuation: number; candidateDigest: string }
  | { phase: 'continue'; continuation: number; candidateDigest: string; ids: string[] };
export interface BuilderResult {
  red?: boolean;
  retryable?: boolean;
  failureLog?: string;
  failureSha256?: string;
  candidateDigest?: string;
  continuations?: number;
  remainingUncarried?: string[];
}
export function legacyFailure(error: string, result: BuilderResult): TaskOutcome<BuilderResult> {
  // Existing v1 stores persist string errors; preserve their bytes at this Pi type seam.
  return { status: 'failed', error, result } as unknown as TaskOutcome<BuilderResult>;
}

