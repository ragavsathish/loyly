// One job: Allure Gherkin identity and stamped item tags (no filesystem).

export interface AllureLabel {
  name: string;
  value: string;
}

export interface AllureIdentityResult {
  name?: string;
  fullName?: string;
  testCaseId?: string;
  historyId?: string;
  labels: AllureLabel[];
}

export interface AllureIdentityExpectation {
  itemId: string;
  name: string;
  rule: string;
  feature: string;
  fullName: string;
}

const PLAN_SOURCE =
  /^docs\/plan\/([0-9]{2}-([a-z][a-z0-9-]*))\/spec\.feature:[0-9]+$/;
const STAMPED_TAG = /^@item-\d\d-\d\d\d$/;

export function parsePlanSource(source: string): {
  planDir: string;
  sliceKey: string;
} {
  const match = PLAN_SOURCE.exec(source);
  if (!match?.[1] || !match[2])
    throw new Error(`invalid checklist source: ${source}`);
  return { planDir: match[1], sliceKey: match[2] };
}

/** Feature title from a `spec.feature` body the adapter already read. */
export function featureTitleFromSpec(specText: string): string {
  const feature = /^Feature:\s*(.+?)\s*$/m.exec(specText)?.[1];
  if (!feature) throw new Error("selected plan has no Feature title");
  return feature;
}

export function allureFullName(opts: {
  project: string;
  sliceKey: string;
  itemId: string;
  blind?: boolean;
}): string {
  if (!/^[a-z][a-z0-9-]*$/.test(opts.project))
    throw new Error(`invalid grading project: ${opts.project}`);
  return `${opts.project}.${opts.sliceKey}.${opts.itemId}${
    opts.blind ? ".blind-agent-review" : ""
  }`;
}

export function labelValues(
  result: AllureIdentityResult,
  name: string,
): string[] {
  return result.labels
    .filter((label) => label.name === name)
    .map((label) => label.value);
}

/** Exactly one stamped `@item-NN-SSS` tag → item id. */
export function stampedItemId(result: AllureIdentityResult): string {
  const tags = labelValues(result, "tag").filter((tag) => STAMPED_TAG.test(tag));
  if (tags.length !== 1 || !tags[0])
    throw new Error("Allure result needs one stamped item tag");
  return tags[0].slice("@item-".length);
}

export function assertAllureIdentity(
  result: AllureIdentityResult,
  expected: AllureIdentityExpectation,
): void {
  if (
    result.name !== expected.name ||
    result.fullName !== expected.fullName ||
    result.testCaseId !== expected.fullName ||
    result.historyId !== expected.fullName ||
    labelValues(result, "feature").join() !== expected.feature ||
    labelValues(result, "story").join() !== expected.rule
  )
    throw new Error(
      `Allure identity or Gherkin labels differ for ${expected.itemId}`,
    );
}
