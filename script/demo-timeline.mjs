// script/render-demo.sh's timing: `cast` caps a cast's pauses and reads its scenes and highlights, `plan` fits each scene
// to its voice and writes the highlight filter (docs/maintainers/development.md).
import { readFileSync, writeFileSync } from "node:fs"

const IDLE = Number(process.env.IDLE ?? 3)
const LEAD = 0.4
const TAIL = 0.8
const read = (path) => JSON.parse(readFileSync(path, "utf8"))
const [command, ...args] = process.argv.slice(2)

if (command === "cast") {
  const [input, output, narrationPath, timelinePath] = args
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

  const end = moved.at(-1)[0]
  // The GIF's own markers, a click's in the video too, mean nothing here.
  const markers = moved.filter(([, kind, label]) => kind === "m" && !/^(caption|key|click) /.test(label))
  const scenes = markers.filter(([, , label]) => !label.startsWith("focus "))
  const named = Object.keys(read(narrationPath).scenes)
  const expected = ["", ...scenes.map(([, , label]) => label)]
  if (JSON.stringify(named) !== JSON.stringify(expected)) {
    console.error(`the narration's scenes are not the cast's: it has\n  ${named.join("\n  ")}\nand the cast, after "", has\n  ${expected.slice(1).join("\n  ")}`)
    process.exit(1)
  }
  // A highlight lasts until "focus off", the next highlight or the next scene.
  const focus = []
  for (const [index, [time, , label]] of markers.entries()) {
    if (!label.startsWith("focus ") || label === "focus off") continue
    const [column, row, columns, rows] = label.split(" ").slice(1).map(Number)
    focus.push({ start: time, end: markers[index + 1]?.[0] ?? end, column, row, columns, rows })
  }
  writeFileSync(timelinePath, JSON.stringify({ bounds: [0, ...scenes.map(([time]) => time), end], focus }))
} else if (command === "plan") {
  const [timelinePath, voicePath, fontSize, filterPath] = args
  const { bounds, focus } = read(timelinePath)
  const { seconds } = read(voicePath)
  const plan = []
  let at = 0
  for (let index = 0; index < bounds.length - 1; index++) {
    const length = bounds[index + 1] - bounds[index]
    const total = Math.max(length, seconds[index] + LEAD + TAIL)
    plan.push({ start: bounds[index], length, total, at })
    at += total
  }
  // A time of the cast in the narrated video, where each scene's last frame is held while its voice runs on.
  const scene = (time) => Math.max(0, plan.findLastIndex((one) => one.start <= time))
  const moved = (time) => plan[scene(time)].at + (time - plan[scene(time)].start)
  // agg's cells: 0.6 of the font size wide and 1.4 high, inside a margin of one cell across and half one down.
  const cell = { width: 0.6 * fontSize, height: 1.4 * fontSize }
  // Boxes only, so a highlight costs the pixels it covers: four dark ones around it, then its frame.
  const boxes = focus.flatMap((one) => {
    const own = plan[scene(one.start)]
    const end = one.end >= own.start + own.length ? own.at + own.total : moved(one.end)
    const when = `enable='between(t,${moved(one.start).toFixed(3)},${end.toFixed(3)})'`
    const x = Math.round(cell.width + (one.column - 1) * cell.width) - 6
    const y = Math.round(cell.height / 2 + (one.row - 1) * cell.height) - 3
    const w = Math.round(one.columns * cell.width) + 12
    const h = Math.round(one.rows * cell.height) + 6
    const dim = (bx, by, bw, bh) => `drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=black@0.6:t=fill:${when}`
    return [
      dim(0, 0, "iw", y),
      dim(0, y + h, "iw", `ih-${y + h}`),
      dim(0, y, x, h),
      dim(x + w, y, `iw-${x + w}`, h),
      `drawbox=x=${x - 3}:y=${y - 3}:w=${w + 6}:h=${h + 6}:color=0xF5A742:t=3:${when}`,
    ]
  })
  const scale = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p"
  writeFileSync(filterPath, [...boxes, scale].join(",\n"))
  for (const one of plan) console.log(`${one.start} ${one.length} ${one.total} ${LEAD}`)
} else {
  console.error("usage: demo-timeline.mjs cast <in.cast> <out.cast> <narration.json> <timeline.json> | plan <timeline.json> <voice.json> <font size> <filter>")
  process.exit(1)
}
