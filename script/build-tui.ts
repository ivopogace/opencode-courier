// the host compiles no JSX in node_modules and provides packages (api-notes)
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
