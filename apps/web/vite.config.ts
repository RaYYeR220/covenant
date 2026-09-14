import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repoRoot = "../..";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { fs: { allow: [repoRoot] } },
  build: { target: "es2020", chunkSizeWarningLimit: 900 }
});
