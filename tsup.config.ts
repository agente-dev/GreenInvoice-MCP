import { defineConfig } from "tsup";

// Bundling config for shipping the server as a single self-contained ESM
// index.js (e.g. bundled inside Electron apps). All runtime deps are inlined;
// the output must have no external imports except node:* builtins.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "bundle",
  clean: true,
  noExternal: ["@modelcontextprotocol/sdk", "zod"],
});
