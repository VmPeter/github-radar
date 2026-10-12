import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { jiraPlugin } from './server/jiraPlugin.ts';

export default defineConfig({
  plugins: [react(), jiraPlugin()],
  server: {
    host: '127.0.0.1',
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**'] },
    port: 5173,
    open: false,
  },
  preview: { host: '127.0.0.1' },
});
