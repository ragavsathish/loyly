export type TaskOutcome<Result> =
  { status: string; result?: Result } | null | undefined;

export interface BuildResult {
  retryable?: boolean;
  failureLog?: string;
  failureSha256?: string;
}

export interface GateResult {
  passed?: boolean;
  candidateSha256?: string;
  log?: string;
  logSha256?: string;
}

export type BuildDecision =
  | { phase: "gate"; attempt: number }
  | {
      phase: "build";
      attempt: number;
      retry: "builder";
      failureLog?: string;
      failureSha256?: string;
    }
  | {
      terminal: true;
      reason: "builder-attempts-exhausted" | "builder-attempt-failed";
      exhausted: boolean;
      attempt: number;
    };

export type GateDecision =
  | { phase: "grading-room"; attempt: number; candidateSha256?: string }
  | {
      phase: "build";
      attempt: number;
      retry: "gate";
      failureLog?: string;
      failureSha256?: string;
    }
  | { terminal: true; reason: "gate-effect-failed"; attempt: number }
  | {
      terminal: true;
      reason: "gate-attempts-exhausted";
      exhausted: true;
      attempt: number;
    };

export type StageDecision =
  { phase: string } | { terminal: true; reason: string };
