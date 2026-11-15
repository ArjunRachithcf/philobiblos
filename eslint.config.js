import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/*.gen.ts', 'design/**', 'apps/web/src/design/**', 'seed/**', 'private/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // WCAG 3.2.2 (On Input): a select or a text field only holds a value until the person acts. Arrow keys on a closed
    // select fire `change`, so a handler there that saves, decides or navigates acts by accident. onChange on these
    // may only call a state setter (setX); deciding takes a button or a menu (ui.tsx MenuButton). Checkboxes, switches
    // and radios toggle on Space or a click, which is the person's act.
    files: ['apps/web/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...[
        'JSXOpeningElement[name.name=/^(select|textarea)$/]',
        'JSXOpeningElement[name.name="input"]:not(:has(JSXAttribute[name.name="type"] > Literal[value=/^(checkbox|radio)$/]))',
      ].flatMap((el) => [
        `${el} > JSXAttribute[name.name="onChange"] > JSXExpressionContainer > ArrowFunctionExpression > CallExpression[callee.name!=/^set[A-Z]/]`,
        `${el} > JSXAttribute[name.name="onChange"] > JSXExpressionContainer > ArrowFunctionExpression > BlockStatement`,
        `${el} > JSXAttribute[name.name="onChange"] > JSXExpressionContainer > Identifier[name!=/^set[A-Z]/]`,
        `${el} > JSXAttribute[name.name="onChange"] > JSXExpressionContainer > :not(ArrowFunctionExpression, Identifier)`,
      ]).map((selector) => ({ selector, message: 'A select or text field acts only through a button or menu (WCAG 3.2.2): its onChange may only call a state setter.' }))],
    },
  },
);
