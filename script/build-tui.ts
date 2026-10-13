// Builds the `tui` entrypoint to dist/tui.js: Solid's JSX compiled for OpenTUI, since the host compiles none
// under node_modules, and every package left external, since the host provides them (docs/plugin-api-notes.md).
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [createSolidTransformPlugin()],
  naming: "[name].js",
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
