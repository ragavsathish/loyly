import noProductLiterals from './rules/no-product-literals.mjs';
import noDeepProjectImports from './rules/no-deep-project-imports.mjs';

const plugin = {
  meta: {
    name: 'eslint-plugin-loyly',
    version: '0.1.0',
  },
  rules: {
    'no-product-literals': noProductLiterals,
    'no-deep-project-imports': noDeepProjectImports,
  },
};

export default plugin;
