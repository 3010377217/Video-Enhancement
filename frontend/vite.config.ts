import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), {
    name: 'desktop-content-policy',
    apply: 'build',
    transformIndexHtml() {
      return [{
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'",
        },
        injectTo: 'head-prepend' as const,
      }];
    },
  }],
  server: { port: 5173, strictPort: true },
});
