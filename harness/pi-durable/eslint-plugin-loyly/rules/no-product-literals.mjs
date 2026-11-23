// Ban hard-coded Löyly product tokens outside project/loyly/.
// Agents must import identity/policy from project/loyly instead of re-embedding IDs.

const BANNED = [
  { value: '01-011', hint: 'BLIND_ITEM_ID' },
  { value: '01-booking-core', hint: 'BOOKING_SLICE' },
  { value: 'booking-core.panel.json', hint: 'DEFAULT_PANEL_PLAN' },
  { value: 'work/blind-review-011.txt', hint: 'BLIND_REFUSAL_FILE' },
  { value: 'blind-review-011.txt', hint: 'basename(BLIND_REFUSAL_FILE)' },
  { value: 'not reached: blind human review required', hint: 'pendingEvidencePrefix / PENDING_HUMAN' },
  {
    value: 'not reached: blind subagent review required',
    hint: 'pendingEvidencePrefix / PENDING_SUBAGENT',
  },
];

const ALLOW_PATH =
  /(^|\/)(project\/loyly\/|test\/|fixture\/|eslint-plugin-loyly\/)/;

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hard-coded Löyly product literals outside project/loyly (import from the project module instead).',
    },
    schema: [],
    messages: {
      banned:
        'Hard-coded product literal {{literal}} — import {{hint}} from project/loyly instead.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (ALLOW_PATH.test(filename.replace(/\\/g, '/'))) return {};
    // Digest-pinned panel workers and the frozen blind adapter keep local product strings.
    if (
      /(^|\/)(blind-agent-adapter|panel-browser|panel-protocol|panel-telemetry|panel-runtime|panel-candidate|runtime-profile-evidence)\.mjs$/.test(
        filename.replace(/\\/g, '/'),
      )
    )
      return {};

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const hit = BANNED.find(
          (entry) => node.value === entry.value || node.value.includes(entry.value),
        );
        if (!hit) return;
        context.report({
          node,
          messageId: 'banned',
          data: { literal: JSON.stringify(hit.value), hint: hit.hint },
        });
      },
      TemplateElement(node) {
        const raw = node.value?.cooked ?? node.value?.raw ?? '';
        const hit = BANNED.find((entry) => raw.includes(entry.value));
        if (!hit) return;
        context.report({
          node,
          messageId: 'banned',
          data: { literal: JSON.stringify(hit.value), hint: hit.hint },
        });
      },
    };
  },
};

export default rule;
