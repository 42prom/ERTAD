import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
// ERTAD's internal imports are bundled so their original module boundaries work in the ESM host.
await build({
  entryPoints: ["src/index.ts", "src/migrate.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  sourcemap: true,
});
await copyFile(
  "src/modules/work/attachment-worker.mjs",
  "dist/attachment-worker.mjs",
);
