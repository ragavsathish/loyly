export function workerBundle(plan: unknown): { root: string; sha256: string | null };
export function specialistWorkers(
  plan: unknown,
): { id: string; script: string; tool: string; item: string }[];
export function runPanelVms(args: Record<string, unknown>): Promise<Record<string, unknown>>;
export function verifyPanelVmRun(args: Record<string, unknown>): {
  out: string;
  manifest: {
    candidate_sha256: string;
    plan_sha256?: string;
    producers: { id: string; status: string; item: string; result: string }[];
  };
};
