// One job: observation shape required beyond the JSON schema, and the
// composed Allure payload check adapters share.
import {
  assertAllureIdentity,
  stampedItemId,
  type AllureIdentityExpectation,
  type AllureIdentityResult,
} from "./validate-identity.ts";
import type { AllureSchemaValidator } from "./validate-schema.ts";

export interface EvidenceResult extends AllureIdentityResult {
  statusDetails?: { message?: string };
  start?: number;
  stop?: number;
  steps?: { status?: string; stage?: string }[];
  attachments?: { source: string }[];
  status?: string;
  stage?: string;
  uuid?: string;
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

/**
 * Schema + stamped `@item-` tag + observation shape, and optional Gherkin
 * identity when the checklist carries a plan source.
 * Adapters still own filesystem (schema bytes, plan text, attachment files).
 */
export function assertAllureResult(
  result: unknown,
  opts: {
    validateSchema: AllureSchemaValidator;
    fileHint?: string;
    identity?: AllureIdentityExpectation;
  },
): { result: EvidenceResult; itemId: string } {
  opts.validateSchema(result, opts.fileHint);
  const row = result as EvidenceResult;
  if (!Array.isArray(row.labels))
    throw new Error("Allure labels missing after schema validation");
  const itemId = stampedItemId(row);
  if (opts.identity) {
    if (itemId !== opts.identity.itemId)
      throw new Error(
        `Allure item tag ${itemId} differs from expected ${opts.identity.itemId}`,
      );
    assertAllureIdentity(row, opts.identity);
  }
  validateResultEvidence(row, itemId);
  return { result: row, itemId };
}
