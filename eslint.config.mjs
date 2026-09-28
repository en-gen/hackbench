import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default [
  {
    ignores: [
      'dist/**',
      'dist-test/**',
      'out/**',
      'coverage/**',
      'build/**',
      'node_modules/**',
      '.gitnexus/**',
      // Throwaway probe code, labelled as such in spike/FINDINGS.md.
      'spike/**',
      // Vendored stand-ins for native modules; kept byte-for-byte.
      'theia/no-native/**',
      // Emitted by Theia's own build, not authored here.
      'theia/**/lib/**',
      'theia/**/src-gen/**',
      // Also generated, and gitignored: present only after a local build, so
      // linting them fails for whoever built and passes in CI, which never has.
      'theia/*/esbuild.mjs',
      'theia/*/gen-esbuild.*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  // Extension host, webviews and the Theia contribution: browser + node.
  {
    files: ['src/**/*.ts', 'theia/extension/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.es2020 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },

  // Tests, tooling and root config: node only.
  {
    files: [
      'test/**/*.{ts,cjs}',
      'tools/**/*.{ts,mjs,cjs}',
      'theia/**/*.{js,cjs}',
      '*.js',
      '*.mjs',
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.es2020 },
    },
  },

  // CommonJS is the point of a .cjs file, and webpack.config.js predates ESM
  // here. Flagging `require` in them is the linter misreading the module
  // system, not a finding.
  {
    files: ['**/*.cjs', 'webpack.config.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // Playwright specs: the callback bodies run in the page, so browser globals
  // are legal there.
  {
    files: ['theia/browser-app/test/**/*.cjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.es2020 },
    },
  },

  // `getSvc`, `getWidget` and `checksumOf` are defined by the GET_SVC
  // preamble that these specs inject into the page, so they are undefined in
  // Node scope and real at page runtime. Declaring them is telling ESLint the
  // truth about where the code runs, not silencing a finding.
  {
    files: ['theia/browser-app/test/**/*.cjs'],
    languageOptions: {
      globals: { getSvc: 'readonly', getWidget: 'readonly', checksumOf: 'readonly' },
    },
  },

  // `revealEmulator` follows the same preamble pattern, but only in this one
  // spec: it calls getSvc/getWidget itself, so it has to run in the page too.
  {
    files: ['theia/browser-app/test/emulator-view.spec.cjs'],
    languageOptions: {
      globals: { revealEmulator: 'readonly' },
    },
  },

  // Tests reach for `any` to build partial fixtures and stub objects that
  // would otherwise need the whole shape spelled out. The rule stays on for
  // src/, which is where an untyped value actually costs something.
  {
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
]
