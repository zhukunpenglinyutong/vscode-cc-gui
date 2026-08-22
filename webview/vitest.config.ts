import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Align with jetbrains-cc-gui: happy-dom handles Selection + KaTeX styles better than jsdom.
    environment: 'happy-dom',
    setupFiles: ['./vitest-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
  },
});
