// Löyly product identity used by Pi adapters and evidence policy.

const PROJECT_ID = 'loyly';
const BLIND_ITEM_ID = '01-011';
const BOOKING_SLICE = '01-booking-core';
const DEFAULT_PANEL_PLAN = 'booking-core.panel.json';
const BLIND_REFUSAL_FILE = 'work/blind-review-011.txt';
const BLIND_SPEC_RELATIVE = `plan/${BOOKING_SLICE}/spec.feature`;

function defaultsBlindReview(project: string): boolean {
  return project === PROJECT_ID;
}

function blindAllureFullName(kind: 'grader' | 'blind-agent-review' = 'grader'): string {
  const base = `${PROJECT_ID}.booking-core.${BLIND_ITEM_ID}`;
  return kind === 'grader' ? base : `${base}.blind-agent-review`;
}

export {
  PROJECT_ID,
  BLIND_ITEM_ID,
  BOOKING_SLICE,
  DEFAULT_PANEL_PLAN,
  BLIND_REFUSAL_FILE,
  BLIND_SPEC_RELATIVE,
  defaultsBlindReview,
  blindAllureFullName,
};
