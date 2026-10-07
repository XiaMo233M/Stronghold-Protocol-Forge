// Correctness lint only (npm run lint). No formatter, no stylistic rules, no repo-wide reformat.
//
// Node: server, shared, tools, scripts, types.
// Browser: public/js (also loaded under Node by unit tests, so `process` is a known global).
// Tests: Node globals plus browser globals (page.evaluate callbacks).
// Warnings (unused vars, and a few rules that fire on intentional patterns) do not fail the run.
// `npm run lint` does not pass --max-warnings=0.

import js from '@eslint/js';
import globals from 'globals';

const unused = ['warn', {
  varsIgnorePattern: '^_',
  argsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
  ignoreRestSiblings: true,
}];

// eslint:recommended, with the style-adjacent rules turned down. Empty `catch { }` is how this
// code skips a missing file; `no-useless-escape` / `no-extra-boolean-cast` / `no-regex-spaces`
// only complain about how a correct expression is written.
const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': unused,
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-useless-escape': 'off',
  'no-extra-boolean-cast': 'off',
  'no-regex-spaces': 'off',
  // `while (true)` is a normal loop. A constant condition anywhere else still warns.
  'no-constant-condition': ['warn', { checkLoops: false }],
  // Calling hasOwnProperty on a foreign object is a real footgun, but a lot of call sites are
  // plain data. Warn; do not fail the build on them.
  'no-prototype-builtins': 'warn',
  // Redundant initializers (`let x = 0; x = …`) are common here and are not behavior bugs.
  'no-useless-assignment': 'warn',
  // Name sanitizers intentionally match control characters.
  'no-control-regex': 'off',
  // ESLint 10 wants `error.cause`. The two hits already put the original message in the text.
  'preserve-caught-error': 'warn',
};

const nodeFiles = [
  'server/**/*.js',
  'shared/**/*.js',
  'tools/**/*.js',
  'tools/**/*.mjs',
  'scripts/**/*.js',
  'scripts/**/*.mjs',
  'types/**/*.js',
];

export default [
  {
    ignores: [
      'node_modules/**',
      'public/vendor/**',
      'public/assets/**',
      'public/fonts/**',
      'public/dev/**',
      '.cache/**',
      'coverage/**',
    ],
  },
  {
    files: nodeFiles,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules,
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, process: 'readonly' },
    },
    rules,
  },
  {
    // 工坊编辑器：`editor/*.mjs` 是 Node 进程（编辑器自己的服务器、试玩服务器）。
    files: ['editor/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules,
  },
  {
    // 编辑器页面：`editor/ui/*.js` 是浏览器模块（页面直接 `<script type="module">` 加载），但同一批文件也被
    // 测试在 Node 下 import（test/stageForm.test.js 等），所以 `process` 与 public/js 一样算已知全局。
    files: ['editor/ui/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, process: 'readonly' },
    },
    rules,
  },
  {
    // Node test runner, plus browser tests whose page.evaluate callbacks use DOM globals.
    // PIXI is the page global those render tests read inside evaluate().
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, PIXI: 'readonly' },
    },
    rules,
  },
];
