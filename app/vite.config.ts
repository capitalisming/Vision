import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BASE_PATH lets the same build run at / (local) or /<repo>/app/ (GitHub Pages)
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  plugins: [react()],
  test: { include: ['src/**/*.test.ts'] },
});
