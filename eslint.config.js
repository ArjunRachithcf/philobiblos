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
    // select fire `change`, so a handler there that saves, decides or navigates acts by accident. onChange on these is
    // exactly one call to a state setter with the event's value (string tidying such as .replace or .slice allowed):
    // `setX` itself, or `(e) => setX(e.target.value ...)`, nothing else (no ||, void, sequences, blocks or other calls).
    // Deciding takes a button or a menu (ui.tsx MenuButton). Checkboxes, switches and radios toggle on Space or a click,
    // which is the person's act. An effect that calls the API when such a state changes gets past this: see ui.tsx.
    files: ['apps/web/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...[
        'JSXOpeningElement[name.name=/^(select|textarea)$/]',
        'JSXOpeningElement[name.name="input"]:not(:has(JSXAttribute[name.name="type"] > Literal[value=/^(checkbox|radio)$/]))',
      ].flatMap((el) => {
        const on = `${el} > JSXAttribute[name.name="onChange"] > JSXExpressionContainer`;
        const call = `${on} > ArrowFunctionExpression > CallExpression`;
        return [
          `${on} > :not(ArrowFunctionExpression, Identifier)`,
          `${on} > Identifier[name!=/^set[A-Z]/]`,
          `${on} > ArrowFunctionExpression > :not(Identifier, CallExpression)`,
          `${call}[callee.name!=/^set[A-Z]/]`,
          `${call}[arguments.length!=1]`,
          `${call}:not(:has(MemberExpression[object.type="Identifier"][property.name="target"]))`,
          `${call} :not(Identifier, MemberExpression, CallExpression, Literal, TSAsExpression, TSTypeReference, TSIndexedAccessType, TSLiteralType, TSUnionType, TSTypeOperator, TSQualifiedName, TemplateElement, PrivateIdentifier)`,
          `${call} CallExpression:not([callee.type="MemberExpression"][callee.property.name=/^(replace|replaceAll|slice|trim|trimStart|toLowerCase|toUpperCase)$/])`,
        ];
      }).map((selector) => ({ selector, message: 'A select or text field acts only through a button or menu (WCAG 3.2.2): its onChange is one call to a state setter with the event value.' }))],
    },
  },
);
