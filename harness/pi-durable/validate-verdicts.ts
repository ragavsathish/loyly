import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateVerdictData } from '../evidence-core/validate-verdicts.ts';
import {
  BLIND_ITEM_ID,
  BLIND_REFUSAL_FILE,
  assertBlindVerdictHandoff,
} from './project/loyly/index.ts';

export function validateVerdicts(room: string) {
  const checklist: unknown = JSON.parse(readFileSync(join(room, 'checklist.json'), 'utf8'));
  const verdicts: unknown = JSON.parse(readFileSync(join(room, 'work', 'verdicts.json'), 'utf8'));
  const surprises: unknown = JSON.parse(readFileSync(join(room, 'work', 'surprises.json'), 'utf8'));
  const judged = validateVerdictData(checklist, verdicts, surprises);
  const blind = judged.verdicts.find((v) => v.id === BLIND_ITEM_ID);
  assertBlindVerdictHandoff(blind, existsSync(join(room, BLIND_REFUSAL_FILE)));
  for (const surprise of judged.surprises) {
    if (!existsSync(join(room, surprise.evidence_file)))
      throw new Error('invalid surprise evidence');
  }
  return judged;
}
