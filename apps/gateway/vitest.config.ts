import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node"
  },
  resolve: {
    alias: {
      "@pebble/protocol": resolve(import.meta.dirname, "../../packages/protocol/src/index.ts")
    }
  }
});
