export interface EvidenceResult {
  statusDetails?: { message?: string };
  start?: number;
  stop?: number;
  steps?: { status?: string; stage?: string }[];
  attachments?: { source: string }[];
}

export function validateResultEvidence(
  result: EvidenceResult,
  itemId: string,
): void {
  if (
    typeof result.statusDetails?.message !== "string" ||
    !result.statusDetails.message.trim() ||
    !Number.isInteger(result.start) ||
    !Number.isInteger(result.stop) ||
    (result.stop ?? -1) < (result.start ?? 0) ||
    !Array.isArray(result.steps) ||
    !result.steps.length ||
    result.steps.some((step) => !step.status || !step.stage)
  )
    throw new Error(
      `Allure observation, timing or steps missing for ${itemId}`,
    );
  if (!Array.isArray(result.attachments) || !result.attachments.length)
    throw new Error(`Allure evidence attachment missing for ${itemId}`);
}
