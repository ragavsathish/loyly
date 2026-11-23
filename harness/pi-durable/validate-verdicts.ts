import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateVerdictData } from '../evidence-core/validate-verdicts.ts';

export function validateVerdicts(room: string) {
  const checklist: unknown = JSON.parse(readFileSync(join(room, 'checklist.json'), 'utf8'));
  const verdicts: unknown = JSON.parse(readFileSync(join(room, 'work', 'verdicts.json'), 'utf8'));
  const surprises: unknown = JSON.parse(readFileSync(join(room, 'work', 'surprises.json'), 'utf8'));
  const judged = validateVerdictData(checklist, verdicts, surprises);
  const blind = judged.verdicts.find((v) => v.id === '01-011');
  if (
    blind &&
    (blind.verdict !== 'fail' ||
      !blind.evidence.startsWith('not reached: blind subagent review required') ||
      !existsSync(join(room, 'work', 'blind-review-011.txt')))
  )
    throw new Error('01-011 needs a separate blind subagent review');
  for (const surprise of judged.surprises) {
    if (!existsSync(join(room, surprise.evidence_file)))
      throw new Error('invalid surprise evidence');
  }
  return judged;
}
