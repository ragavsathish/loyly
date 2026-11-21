// Reject a panel that cannot account for the selected scored cut before a
// builder or grader starts. The panel remains a separate, pinned instrument.
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { specialistWorkers } from './panel-vm-run.mjs';
import { validatePanelCoverage } from '../evidence-core/panel-selection.ts';

const schema = JSON.parse(readFileSync(new URL('./panel-plan.schema.json', import.meta.url)));
const validateSchema = new Ajv2020({ strict: false }).compile(schema);

export function validatePanelSelection(plan, checklist) {
  if (!validateSchema(plan))
    throw new Error(`panel plan schema: ${JSON.stringify(validateSchema.errors)}`);
  const legacy = plan.schema === 'loyly.grading-panel-plan.v1';
  const coverage = validatePanelCoverage(plan, checklist, legacy ? '01-011' : undefined);
  const specialists = specialistWorkers(plan);
  return { selected: coverage.selected, specialists: specialists.map((worker) => worker.id) };
}
