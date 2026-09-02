// ESLint 9 (flat config) — единый конфиг монорепозитория.
// Заведён Пунктом [lint-ci-strict] (аудит 2026-09-01): до него линтера
// в проекте не было вообще, а 45 директив eslint-disable в исходниках
// ничего не подавляли — их никто не читал.
//
// Ключевой мотив — type-aware правила для async-кодовой базы:
// no-floating-promises и no-misused-promises. Именно они ловят
// «забытый await» — класс багов, который тайпчек не видит, а тест
// ловит только если специально написан.
//
// Тип-зависимые правила требуют TS-программы, поэтому включён
// projectService: каждый файл резолвится в tsconfig своего приложения.
// Файлы вне tsconfig (конфиги сборки, скрипты) линтуются без типов.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';

const NEXT_APPS = ['apps/tma', 'apps/admin', 'apps/landing'];

/** Правила Next.js (плагин отдаёт их в eslintrc-формате — берём rules). */
const nextRules = {
  ...nextPlugin.configs.recommended.rules,
  ...nextPlugin.configs['core-web-vitals'].rules,
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'apps/api/prisma/migrations/**',
      'apps/*/public/**',
      '**/*.tsbuildinfo',
    ],
  },

  // ─────────────────── база для всего TypeScript ───────────────────
  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── ядро задачи: асинхронность ──
      // Незаваченный промис в NestJS-сервисе = потерянная ошибка и
      // ответ пользователю раньше, чем завершилась запись в БД.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        // async-функция как обработчик void-события (setTimeout,
        // addEventListener) — распространённый и осознанный паттерн,
        // ловим только опасное: промис в условии.
        { checksVoidReturn: false },
      ],
      '@typescript-eslint/await-thenable': 'error',
      'require-atomic-updates': 'off',

      // ── типы ──
      '@typescript-eslint/no-explicit-any': 'off', // фейки в спеках и Prisma-JSON — осознанный any
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-empty-object-type': 'off', // пустые DTO — отдельный пункт бэклога (ValidationPipe)
      '@typescript-eslint/no-require-imports': 'off',

      // ── дисциплина ──
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },

  // ─────────────────── API (NestJS, Node) ───────────────────
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
  {
    // Скрипты и сиды — консоль это их интерфейс.
    files: [
      'apps/api/prisma/**/*.ts',
      'apps/api/scripts/**/*.ts',
      'scripts/**/*.js',
      'apps/api/src/main.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    // Спеки: standalone-раннер печатает результат в консоль,
    // самодельные фейки — это any по своей природе.
    files: ['apps/api/src/__tests__/**/*.ts', 'apps/tma/src/__tests__/**/*.ts', 'apps/landing/src/__tests__/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },

  // ─────────────────── Next.js-приложения ───────────────────
  {
    files: NEXT_APPS.map((a) => `${a}/**/*.{ts,tsx}`),
    plugins: {
      react,
      'react-hooks': reactHooks,
      '@next/next': nextPlugin,
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      ...nextRules,
      // exhaustive-deps по умолчанию warn — в этом проекте он ошибка:
      // на нём висели 32 из 45 директив eslint-disable, и часть из них
      // скрывала реальные пропуски зависимостей (см. отчёт аудита;
      // цифра уточнена повторным аудитом — было сказано «45»).
      'react-hooks/exhaustive-deps': 'error',
      'react/prop-types': 'off', // типы приходят из TypeScript
      'react/no-unescaped-entities': 'off',
      // Все три приложения — App Router, каталога pages/ нет; иначе правило
      // печатает «Pages directory cannot be found» на каждом запуске.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  // ─────────────────── JS-конфиги вне TS-программы ───────────────────
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
