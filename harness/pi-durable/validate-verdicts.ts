import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSelectedChecklist, type Surprise, type Verdict } from './contracts.ts';

function isVerdict(value: unknown): value is Verdict {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'verdict' in value &&
    (value.verdict === 'pass' || value.verdict === 'fail') &&
    'evidence' in value &&
    typeof value.evidence === 'string'
  );
}

function isSurprise(value: unknown): value is Surprise {
  return (
    typeof value === 'object' &&
    value !== null &&
    'item' in value &&
    typeof value.item === 'string' &&
    'observation' in value &&
    typeof value.observation === 'string' &&
    'evidence_file' in value &&
    typeof value.evidence_file === 'string'
  );
}

export function validateVerdicts(room: string): {
  verdicts: Verdict[];
  surprises: Surprise[];
  pass: number;
} {
  const checklist: unknown = JSON.parse(readFileSync(join(room, 'checklist.json'), 'utf8'));
  if (!isSelectedChecklist(checklist)) throw new Error('invalid grading checklist');
  const ids = checklist.items.map((item) => item.id);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('invalid grading checklist');
  const rawVerdicts: unknown = JSON.parse(
    readFileSync(join(room, 'work', 'verdicts.json'), 'utf8'),
  );
  const rawSurprises: unknown = JSON.parse(
    readFileSync(join(room, 'work', 'surprises.json'), 'utf8'),
  );
  if (!Array.isArray(rawVerdicts) || rawVerdicts.length !== ids.length)
    throw new Error('grader did not return one verdict per selected item');
  if (!rawVerdicts.every(isVerdict)) throw new Error('invalid grader verdict shape');
  const verdicts: Verdict[] = rawVerdicts;
  for (let i = 0; i < ids.length; i++) {
    const v = verdicts[i];
    if (
      !v ||
      v.id !== ids[i] ||
      !['pass', 'fail'].includes(v.verdict) ||
      typeof v.evidence !== 'string' ||
      !v.evidence.trim()
    )
      throw new Error(`invalid verdict for ${ids[i]}`);
  }
  const blind = verdicts.find((v) => v.id === '01-011');
  if (
    blind &&
    (blind.verdict !== 'fail' ||
      !blind.evidence.startsWith('not reached: blind subagent review required') ||
      !existsSync(join(room, 'work', 'blind-review-011.txt')))
  )
    throw new Error('01-011 needs a separate blind subagent review');
  if (!Array.isArray(rawSurprises)) throw new Error('surprises must be a JSON array');
  if (!rawSurprises.every(isSurprise)) throw new Error('invalid surprise evidence');
  const surprises: Surprise[] = rawSurprises;
  for (const surprise of surprises) {
    if (
      !ids.includes(surprise?.item) ||
      typeof surprise.observation !== 'string' ||
      typeof surprise.evidence_file !== 'string' ||
      !/^work\/[A-Za-z0-9._/-]+$/.test(surprise.evidence_file) ||
      surprise.evidence_file.includes('..') ||
      !existsSync(join(room, surprise.evidence_file))
    )
      throw new Error('invalid surprise evidence');
  }
  return { verdicts, surprises, pass: verdicts.filter((v) => v.verdict === 'pass').length };
}
