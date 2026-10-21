// Writes what tmux's pipe-pane hands it as an asciicast v2 file, for script/record-demo.sh.
//   node script/demo-cast.mjs <out.cast> <columns> <rows> <marks file>
// Each chunk of the pane's output is an "o" event; each `<epoch ms>\t<label>` line of the marks file, written by the
// recorder as a scene starts, is an "m" marker. Events go to <out.cast>.part as they come, which becomes <out.cast> at the end.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"

const [out, columns, rows, marks] = process.argv.slice(2)
const start = Date.now()
const part = `${out}.part`
const decoder = new TextDecoder("utf-8")
const at = (ms) => Number(((ms - start) / 1000).toFixed(6))

writeFileSync(part, `${JSON.stringify({ version: 2, width: Number(columns), height: Number(rows), timestamp: Math.floor(start / 1000) })}\n`)
process.stdin.on("data", (chunk) => {
  const text = decoder.decode(chunk, { stream: true })
  if (text) appendFileSync(part, `${JSON.stringify([at(Date.now()), "o", text])}\n`)
})
process.stdin.on("end", () => {
  const [header, ...events] = readFileSync(part, "utf8").trimEnd().split("\n")
  const markers = existsSync(marks)
    ? readFileSync(marks, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t"))
        .map(([ms, label]) => JSON.stringify([Math.max(0, at(Number(ms))), "m", label]))
    : []
  const time = (line) => JSON.parse(line)[0]
  const merged = [...events, ...markers].map((line, index) => ({ line, index })).sort((a, b) => time(a.line) - time(b.line) || a.index - b.index)
  writeFileSync(part, [header, ...merged.map((one) => one.line)].join("\n") + "\n")
  renameSync(part, out)
})
