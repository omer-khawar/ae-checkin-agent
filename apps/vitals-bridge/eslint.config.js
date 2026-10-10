// ESLint flat config (ESLint 9) with typescript-eslint's type-checked preset.
// `npm run lint` runs `eslint .`; the project service picks up tsconfig.json for type information.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const here = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: here },
    },
    rules: {
      // Leading-underscore parameters are intentionally unused (interface conformance in stubs).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Fire-and-forget promises must be explicit (`void p`), never accidental.
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  // Tooling files are plain JS: no type information available or needed.
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
);
