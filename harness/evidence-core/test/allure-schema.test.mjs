import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileAllureSchema } from "../validate-schema.ts";
import {
  allureFullName,
  featureTitleFromSpec,
  parsePlanSource,
  stampedItemId,
} from "../validate-identity.ts";
import { assertAllureResult } from "../validate-result.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(join(HERE, "../allure-lifecycle-result.schema.json"), "utf8"),
);

function minimalResult(overrides = {}) {
  return {
    uuid: "11111111-1111-1111-1111-111111111111",
    name: "The schedule",
    status: "passed",
    stage: "finished",
    statusDetails: { message: "Observed over HTTP" },
    start: 1,
    stop: 2,
    labels: [
      { name: "lifecycle", value: "pre-production" },
      { name: "technique", value: "acceptance" },
      { name: "tool", value: "test grader" },
      { name: "feature", value: "Booking core" },
      { name: "story", value: "Availability" },
      { name: "tag", value: "@item-01-001" },
    ],
    steps: [{ name: "When", status: "passed", stage: "finished" }],
    attachments: [
      {
        name: "probe",
        source: "11111111-1111-1111-1111-111111111111-attachment.txt",
        type: "text/plain",
      },
    ],
    ...overrides,
  };
}

test("compileAllureSchema rejects missing lifecycle label", () => {
  const validate = compileAllureSchema(schema);
  const bad = minimalResult();
  bad.labels = bad.labels.filter((label) => label.name !== "lifecycle");
  assert.throws(() => validate(bad, "x-result.json"), /Allure schema rejected/);
  assert.doesNotThrow(() => validate(minimalResult()));
});

test("plan source, feature title and fullName are pure", () => {
  assert.deepEqual(
    parsePlanSource("docs/plan/01-booking-core/spec.feature:12"),
    { planDir: "01-booking-core", sliceKey: "booking-core" },
  );
  assert.equal(
    featureTitleFromSpec("Feature: Booking core\n"),
    "Booking core",
  );
  assert.equal(
    allureFullName({
      project: "loyly",
      sliceKey: "booking-core",
      itemId: "01-011",
      blind: true,
    }),
    "loyly.booking-core.01-011.blind-agent-review",
  );
});

test("assertAllureResult binds schema, stamp, identity and evidence", () => {
  const validateSchema = compileAllureSchema(schema);
  const fullName = "loyly.booking-core.01-001";
  const row = minimalResult({
    fullName,
    testCaseId: fullName,
    historyId: fullName,
  });
  const ok = assertAllureResult(row, {
    validateSchema,
    identity: {
      itemId: "01-001",
      name: "The schedule",
      rule: "Availability",
      feature: "Booking core",
      fullName,
    },
  });
  assert.equal(ok.itemId, "01-001");
  assert.equal(stampedItemId(ok.result), "01-001");
  assert.throws(
    () =>
      assertAllureResult(row, {
        validateSchema,
        identity: {
          itemId: "01-001",
          name: "Wrong",
          rule: "Availability",
          feature: "Booking core",
          fullName,
        },
      }),
    /identity or Gherkin/,
  );
});
