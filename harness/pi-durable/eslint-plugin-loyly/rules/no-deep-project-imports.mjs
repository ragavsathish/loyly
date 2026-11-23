// Prefer the project/loyly barrel so agents do not couple to internal file layout.

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Import Löyly project symbols from project/loyly/index.ts, not deep internal paths.',
    },
    schema: [],
    messages: {
      deep: 'Import from project/loyly/index.ts instead of {{source}}.',
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename()).replace(/\\/g, '/');
    if (/(^|\/)(project\/loyly\/|test\/|eslint-plugin-loyly\/)/.test(filename)) return {};

    return {
      ImportDeclaration(node) {
        const source = node.source?.value;
        if (typeof source !== 'string') return;
        if (!/project\/loyly\/(?!index\.ts$).+/.test(source)) return;
        context.report({
          node: node.source,
          messageId: 'deep',
          data: { source },
        });
      },
    };
  },
};

export default rule;
