const fs = require("node:fs");
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // Provided by the extension host at runtime; must never be bundled.
  external: ["vscode"],
  sourcemap: !production,
  minify: false,
  logLevel: "info",
};

async function main() {
  // Stale artefacts (e.g. a dev sourcemap) must not survive into a production bundle.
  fs.rmSync("dist", { recursive: true, force: true });

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    return;
  }
  await esbuild.build(options);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
