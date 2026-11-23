// Reject a panel that cannot account for the selected scored cut before a
// builder or grader starts. The panel remains a separate, pinned instrument.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { specialistWorkers } from './panel-vm-run.mjs';
import { validatePanelCoverage } from '../evidence-core/panel-selection.ts';

interface PanelPlanDocument {
  schema?: string;
  checks?: unknown[];
  [key: string]: unknown;
}

interface SelectedChecklist {
  items: { id: string }[];
}

interface PanelSelectionResult {
  selected: string[];
  specialists: string[];
}

const schema = JSON.parse(
  readFileSync(new URL('./panel-plan.schema.json', import.meta.url), 'utf8'),
) as object;
const validateSchema = new Ajv2020({ strict: false }).compile(schema);

function validatePanelSelection(
  plan: PanelPlanDocument,
  checklist: SelectedChecklist,
): PanelSelectionResult {
  if (!validateSchema(plan))
    throw new Error(`panel plan schema: ${JSON.stringify(validateSchema.errors)}`);
  const legacy = plan.schema === 'loyly.grading-panel-plan.v1';
  const coverage = validatePanelCoverage(plan as never, checklist, legacy ? '01-011' : undefined);
  const specialists = specialistWorkers(plan);
  return {
    selected: coverage.selected,
    specialists: (specialists as { id: string }[]).map((worker) => worker.id),
  };
}

export type { PanelPlanDocument, SelectedChecklist, PanelSelectionResult };
export { validatePanelSelection };
