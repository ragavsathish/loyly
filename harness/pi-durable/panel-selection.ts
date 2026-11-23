// Reject a panel that cannot account for the selected scored cut before a
// builder or grader starts. The panel remains a separate, pinned instrument.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { specialistWorkers } from './panel-vm-run.ts';
import { validatePanelCoverage } from '../evidence-core/panel-selection.ts';
import { BLIND_ITEM_ID, LEGACY_PANEL_PLAN } from './project/loyly/index.ts';

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
  const legacy = plan.schema === LEGACY_PANEL_PLAN;
  const coverage = validatePanelCoverage(
    plan as never,
    checklist,
    legacy ? BLIND_ITEM_ID : undefined,
  );
  const specialists = specialistWorkers(plan) as { id: string }[];
  return {
    selected: coverage.selected,
    specialists: specialists.map((worker) => worker.id),
  };
}

export type { PanelPlanDocument, SelectedChecklist, PanelSelectionResult };
export { validatePanelSelection };
