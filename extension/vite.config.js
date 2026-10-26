import { cpSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const extensionRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: extensionRoot,
  publicDir: resolve(extensionRoot, "public"),
  build: {
    outDir: resolve(extensionRoot, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        dashboard: resolve(extensionRoot, "dashboard.html"),
        offscreen: resolve(extensionRoot, "offscreen.html"),
      },
    },
  },
  plugins: [
    {
      name: "copy-local-mediapipe-assets",
      closeBundle() {
        const assetsDirectory = resolve(extensionRoot, "dist", "assets");
        mkdirSync(assetsDirectory, { recursive: true });
        cpSync(
          resolve(
            extensionRoot,
            "node_modules",
            "@mediapipe",
            "tasks-vision",
            "wasm",
          ),
          resolve(assetsDirectory, "wasm"),
          { recursive: true },
        );
        copyFileSync(
          resolve(extensionRoot, "..", "models", "hand_landmarker.task"),
          resolve(assetsDirectory, "hand_landmarker.task"),
        );
      },
    },
  ],
});
