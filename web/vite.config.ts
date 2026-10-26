// The React frontend. `npm run build` compiles it into dist/public, which the
// Express server serves (see server.ts); in development `npm run dev:web`
// serves it with instant reload and forwards /api to the Express server.
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" },
  },
});
