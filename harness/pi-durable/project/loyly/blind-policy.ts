// Löyly v1 blind-handoff policy for item 01-011.
import { BLIND_ITEM_ID, PROJECT_ID } from './identity.ts';

/** Historical person-worded booking-core cut; cannot be scored by a blind subagent. */
const PERSON_SPEC_SHA256 = 'b28ee83dfaada8df0ed99b90121a50f3c55885ade4db323b68e03c4d5f15005e';

const BLIND_QUESTION =
  'Without reading the sauna-day configuration or another project file, read only refusal.txt. ' +
  'Name a request you expect to be accepted using that refusal alone.\n';

const PENDING_HUMAN = 'not reached: blind human review required';
const PENDING_SUBAGENT = 'not reached: blind subagent review required';

function requiresBlindHandoff(project: string, items: { id: string }[]): boolean {
  return project === PROJECT_ID && items.some((item) => item.id === BLIND_ITEM_ID);
}

function pendingEvidencePrefix(specSha256: string | null): string {
  return specSha256 === PERSON_SPEC_SHA256 ? PENDING_HUMAN : PENDING_SUBAGENT;
}

function isHistoricalPersonCut(specSha256: string): boolean {
  return specSha256 === PERSON_SPEC_SHA256;
}

function isBlindPendingResult(
  result: { status: string; stage: string; statusDetails: { message: string } },
  pendingPrefix: string,
): boolean {
  return (
    result.status === 'skipped' &&
    result.stage === 'pending' &&
    result.statusDetails.message.startsWith(pendingPrefix)
  );
}

function assertBlindVerdictHandoff(
  blind:
    | {
        verdict: string;
        evidence: string;
      }
    | undefined,
  refusalExists: boolean,
): void {
  if (!blind) return;
  if (blind.verdict !== 'fail' || !blind.evidence.startsWith(PENDING_SUBAGENT) || !refusalExists)
    throw new Error(`${BLIND_ITEM_ID} needs a separate blind subagent review`);
}

export {
  BLIND_QUESTION,
  requiresBlindHandoff,
  pendingEvidencePrefix,
  isHistoricalPersonCut,
  isBlindPendingResult,
  assertBlindVerdictHandoff,
};
