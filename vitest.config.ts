/// <reference types="vitest" />
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tsconfigPaths(), // This plugin handles the path aliases
  ],
  test: {
    // Vitest configuration options
    include: ["src/index.test.ts"], // Explicitly include ONLY this file
    exclude: ["src/legacy.test.ts", "node_modules/**"], // Explicitly exclude the legacy file
    globals: true, // Use global APIs like describe, it, etc.
    environment: "miniflare", // Use Miniflare environment for Workers testing (optional but recommended)
    // environmentOptions: { // Optional: Configure Miniflare further
    //   bindings: { /* Mock bindings here if needed */ }
    // }
  },
});
