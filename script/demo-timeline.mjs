// Prepares a cast from script/record-demo.sh for script/render-demo.sh: caps each pause at IDLE seconds, moving the scene
// markers with it, and checks that the narration has a scene for each marker, in the same order.
//   node script/demo-timeline.mjs <in.cast> <out.cast> <narration.json>
// Writes <out.cast> and prints the scene bounds in seconds, from 0 to the end, one per line.
import { readFileSync, writeFileSync } from "node:fs"

const IDLE = Number(process.env.IDLE ?? 3)
const [input, output, narrationPath] = process.argv.slice(2)
const [header, ...events] = readFileSync(input, "utf8").trimEnd().split("\n")
let last = 0
let shift = 0
const moved = events.map((line) => {
  const [time, kind, data] = JSON.parse(line)
  shift += Math.max(0, time - last - IDLE)
  last = time
  return [Number((time - shift).toFixed(6)), kind, data]
})
writeFileSync(output, [header, ...moved.map((event) => JSON.stringify(event))].join("\n") + "\n")

const markers = moved.filter(([, kind]) => kind === "m")
const scenes = Object.keys(JSON.parse(readFileSync(narrationPath, "utf8")).scenes)
const expected = ["", ...markers.map(([, , label]) => label)]
if (JSON.stringify(scenes) !== JSON.stringify(expected)) {
  console.error(`the narration's scenes are not the cast's: it has\n  ${scenes.join("\n  ")}\nand the cast, after "", has\n  ${expected.slice(1).join("\n  ")}`)
  process.exit(1)
}
console.log([0, ...markers.map(([time]) => time), moved.at(-1)[0]].join("\n"))
