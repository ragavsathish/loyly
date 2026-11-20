// Reject a panel that cannot account for the selected scored cut before a
// builder or grader starts. The panel remains a separate, pinned instrument.
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { specialistWorkers } from './panel-vm-run.mjs';

const schema = JSON.parse(readFileSync(new URL('./panel-plan.schema.json', import.meta.url)));
const validateSchema = new Ajv2020({ strict: false }).compile(schema);

export function validatePanelSelection(plan, checklist) {
  if (!validateSchema(plan))
    throw new Error(`panel plan schema: ${JSON.stringify(validateSchema.errors)}`);
  const ids = checklist?.items?.map((item) => item.id);
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
    throw new Error('panel selection needs a unique scored checklist');
  const selected = new Set(ids);
  if (!selected.has('01-011'))
    throw new Error('current Pi blind handoff requires selected item 01-011');
  const checkIds = plan.checks.map((check) => check.id);
  if (new Set(checkIds).size !== checkIds.length)
    throw new Error('panel check IDs must be unique');
  const raw = plan.checks.filter((check) => check.source === 'raw-grader');
  const rawIds = raw.flatMap((check) => check.items);
  if (rawIds.length !== ids.length || new Set(rawIds).size !== ids.length
      || rawIds.some((id) => !selected.has(id)))
    throw new Error('raw grader checks must exactly cover selected checklist items');
  if (raw.some((check) => check.items.some((id) =>
    check.role !== (id === '01-011' ? 'handoff' : 'scored'))))
    throw new Error('raw grader roles differ from the selected blind handoff');
  const blind = plan.checks.filter((check) => check.source === 'blind-review');
  if (blind.length !== 1 || blind[0].role !== 'scored'
      || blind[0].items.length !== 1 || blind[0].items[0] !== '01-011')
    throw new Error('panel needs one scored blind review for 01-011');
  const specialists = specialistWorkers(plan);
  if (plan.checks.some((check) => check.source === 'specialist'
      && !['corroborating', 'diagnostic'].includes(check.role)))
    throw new Error('specialist checks may corroborate or diagnose, not file a score');
  if (specialists.some((worker) => !selected.has(worker.item)))
    throw new Error('specialist check names an unselected item');
  return { selected: ids, specialists: specialists.map((worker) => worker.id) };
}
