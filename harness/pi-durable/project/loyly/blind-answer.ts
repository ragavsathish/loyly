// Parse the one-line REQUEST / UNUSABLE answer from a Löyly blind agent.

const DAYS = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';
const REQUEST = new RegExp(
  `^REQUEST:\\s*pukuhuone\\s+(\\d+)\\s*\\|\\s*(${DAYS})\\s*\\|\\s*(\\d{2}:\\d{2})$`,
  'i',
);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface BlindAgentRequest {
  method: 'POST';
  path: '@booking-form';
  body: string;
  matches_answer: true;
}

interface BlindAgentParsed {
  verdict: 'pass' | 'fail';
  reason: string;
  request: BlindAgentRequest | null;
}

function parseBlindAgentAnswer(answer: string, refusal: string): BlindAgentParsed {
  const line = answer.trim();
  const unusable = /^UNUSABLE:\s*(.{3,500})$/i.exec(line);
  if (unusable) return { verdict: 'fail', reason: unusable[1]!, request: null };
  const match = REQUEST.exec(line);
  if (!match) throw new Error('blind agent answer did not use REQUEST or UNUSABLE format');
  const [, number, weekdayRaw, start] = match;
  const weekday = weekdayRaw![0]!.toUpperCase() + weekdayRaw!.slice(1).toLowerCase();
  const validTime = (value: string) =>
    Number(value.slice(0, 2)) <= 23 && Number(value.slice(3)) <= 59;
  if (
    !validTime(start!) ||
    !new RegExp(`pukuhuone\\s*${escape(number!)}\\b`, 'i').test(refusal) ||
    !new RegExp(`\\b${escape(weekday)}\\b`, 'i').test(refusal) ||
    !refusal.includes(start!)
  )
    throw new Error('blind agent named a room, day or start time absent from the refusal');
  return {
    verdict: 'pass',
    reason: 'The fresh agent named a request from the refusal; HTTP confirmation follows.',
    request: {
      method: 'POST',
      path: '@booking-form',
      body: new URLSearchParams({
        household: '12',
        resource: `@room:${number}`,
        weekday,
        start: start!,
      }).toString(),
      matches_answer: true,
    },
  };
}

export type { BlindAgentRequest, BlindAgentParsed };
export { parseBlindAgentAnswer };
