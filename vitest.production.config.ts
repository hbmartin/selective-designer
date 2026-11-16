import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    include: ['tests/production/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
});
