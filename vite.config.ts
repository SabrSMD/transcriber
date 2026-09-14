import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1421,
    strictPort: true,
    // Explicit IPv4 loopback instead of `false` (Vite's own default): on
    // this machine `false`/"localhost" resolves to binding IPv6-only
    // ([::1]:1421), which the Tauri dev-server check and the WebView2
    // embedded browser can't reach over IPv4 127.0.0.1 - causing
    // `tauri dev` to time out even though Vite reports itself as ready.
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1422,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and the Python engine
      // (engine/venv alone is hundreds of thousands of files - torch, numba,
      // matplotlib, etc. - watching it made the dev server unresponsive)
      ignored: ["**/src-tauri/**", "**/engine/**"],
    },
  },
}));
