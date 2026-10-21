import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/providers/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
