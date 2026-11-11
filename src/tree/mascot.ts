export type Token = "b" | "k" | "g" | "m" | "a" | "w" | "e" | "s"

export type MascotState = "idle" | "spawn" | "running" | "waiting" | "stalled" | "report" | "gone"

export type Cell = { readonly char: string; readonly fg?: Token; readonly bg?: Token }

export const MASCOT_EVERY = 5

export const BLINK_EVERY = 11

export const DIG_EVERY = 18

export const GLYPH: Readonly<Record<MascotState, ReadonlyArray<ReadonlyArray<string>>>> = {
  idle: [["........", "........", "..gggg..", "gggggggg"]],
  spawn: [
    ["........", "...bb...", "g.bbbb.g", "gggggggg"],
    [".g....g.", "...bb...", "ggbbbbgg", "gggggggg"],
  ],
  running: [
    ...Array.from({ length: DIG_EVERY }, () => ["..bbbb..", ".bkbbkb.", "gbbaabbg", "gggggggg"]),
    ...["m.bbbb.m", ".mbbbbm.", "..bbbb..", "m.bbbb.m", ".mbbbbm.", "..bbbb.."].map((top) => [top, ".bkbbkb.", "gbbaabbg", "gggggggg"]),
  ],
  waiting: [
    [".bbbbbbw", ".bkbbkbw", ".bbaabbm", "ggggggg."],
    [".bbbbbbb", ".bkbbkbb", ".bbaabbm", "ggggggg."],
  ],
  stalled: [
    ["..e.....", ".bbbbbb.", ".bkbbkb.", "gbbaabbg"],
    ["..e.e...", ".bbbbbb.", ".bkbbkb.", "gbbaabbg"],
    ["..e.e.e.", ".bbbbbb.", ".bkbbkb.", "gbbaabbg"],
  ],
  report: [
    ["......aa", "bbbbbbaa", "bkbbkbm.", "bbaabbm."],
    ["s.....aa", "bbbbbbaa", "bkbbkbm.", "bbaabbm."],
  ],
  gone: [["........", ".mmmmmm.", ".mkmmkm.", "mmmmmmmm"]],
}

const OPEN_EYES: ReadonlySet<MascotState> = new Set(["waiting", "report", "running"])

export function glyph(state: MascotState, frame?: number): ReadonlyArray<string> {
  const frames = GLYPH[state]
  const pixels = frames[(frame ?? 0) % frames.length]!
  if (frame === undefined) return pixels
  if (state === "idle" && breathesOut(frame)) return [...pixels.slice(0, 2), ".gggggg.", ...pixels.slice(3)]
  return OPEN_EYES.has(state) && blinks(frame) ? pixels.map((row) => row.replaceAll("k", "b")) : pixels
}

const breathesOut = (frame: number) => Math.floor(frame / 2) % 2 === 1

const blinks = (frame: number) => frame % BLINK_EVERY === BLINK_EVERY - 1

export function cells(pixels: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<Cell>> {
  const lines: Cell[][] = []
  for (let row = 0; row < pixels.length; row += 2) {
    const top = pixels[row]!
    const bottom = pixels[row + 1] ?? ""
    lines.push([...top].map((pixel, column) => cell(token(pixel), token(bottom[column]))))
  }
  return lines
}

const token = (pixel: string | undefined) => (pixel && pixel !== "." ? (pixel as Token) : undefined)

function cell(top: Token | undefined, bottom: Token | undefined): Cell {
  if (!top && !bottom) return { char: " " }
  if (!top) return { char: "▄", fg: bottom }
  if (top === bottom) return { char: "█", fg: top }
  return bottom ? { char: "▀", fg: top, bg: bottom } : { char: "▀", fg: top }
}

const SIZE = 16

export type Eyes = "open" | "wide" | "shut" | "none"

const SLUMP = [2, 2, 2, 1, 1, 0, 0]

export function digby(
  rise: number,
  { top = 6, eyes = "open", slump = false, shift = 0, mound = "g" }: { top?: number; eyes?: Eyes; slump?: boolean; shift?: number; mound?: "g" | "m" } = {},
): ReadonlyArray<string> {
  const grid = Array.from({ length: SIZE }, () => new Array<string>(SIZE).fill("."))
  const span = (row: number, width: number, pixel: string, skip = (_column: number) => false, by = 0) => {
    if (row < 0 || row >= SIZE) return
    for (let column = (SIZE - width) / 2; column < (SIZE + width) / 2; column++) if (!skip(column)) grid[row]![column + by] = pixel
  }
  const head = Math.round(10 - 8 * rise)
  const lean = (at: number) => (slump ? SLUMP[at]! : 0)
  ;[4, 6, 8, 8, 8, 6, 4].forEach((width, at) => span(head + at, width, "b", undefined, lean(at)))
  for (let row = head + 7; row <= 11; row++) span(row, 4, "b")
  const eyeColumns = eyes === "shut" ? [5, 6, 9, 10] : [6, 9]
  if (eyes !== "none") span(head + 3, 8, "k", (column) => !eyeColumns.includes(column), lean(3))
  if (eyes === "wide") span(head + 2, 8, "k", (column) => !eyeColumns.includes(column), lean(2))
  span(head + 4, 2, "a", undefined, lean(4))
  span(10, SIZE, ".", (column) => column >= 6 && column <= 9)
  span(10, top, mound, (column) => column + shift >= 6 && column + shift <= 9, shift)
  span(11, 10, mound, undefined, shift)
  span(12, 12, mound, undefined, shift)
  for (const row of [13, 14, 15]) span(row, SIZE, mound)
  return grid.map((row) => row.join(""))
}

type Spot = readonly [row: number, column: number, pixels: string]

export function paint(pixels: ReadonlyArray<string>, spots: ReadonlyArray<Spot>): ReadonlyArray<string> {
  const grid = pixels.map((row) => [...row])
  for (const [row, column, drawn] of spots)
    [...drawn].forEach((pixel, at) => {
      if (pixel !== "." && grid[row]?.[column + at] !== undefined) grid[row]![column + at] = pixel
    })
  return grid.map((row) => row.join(""))
}

const post = (row: number, column: number, length: number, pixel: string): Spot[] =>
  Array.from({ length }, (_, at) => [row + at, column, pixel] as const)

const headTop = (rise: number) => Math.round(10 - 8 * rise)

const awake = (rise: number, shift: number) => (open: boolean) => {
  const row = headTop(rise) + 3
  return paint(digby(rise, { eyes: "open" }), [[row, 6, "b"], [row, 9, "b"], ...(open ? ([[row, 6 + shift, "k"], [row, 9 + shift, "k"]] as const) : [])])
}

const CLOD_LEFT = [[8, 3], [7, 2], [6, 1], [5, 0], [7, 0], [9, 0]] as const
const CLOD_RIGHT = [[8, 12], [7, 13], [6, 14], [5, 15], [7, 15], [9, 15]] as const
const CLODS = [[CLOD_LEFT, 0], [CLOD_LEFT, 3], [CLOD_RIGHT, 1], [CLOD_RIGHT, 4]] as const

const digging = (at: number) => (open: boolean) =>
  paint(
    digby(0.6, { eyes: open ? "open" : "none" }),
    CLODS.map(([path, phase]) => {
      const [row, column] = path[(at + phase) % path.length]!
      return [row, column, "m"] as const
    }),
  )

const running = [
  ...Array.from({ length: DIG_EVERY }, (_, at) => [0, 0, 0, 0, 0, -1, -1, 0, 0, 0, 1, 1][at % 12]!).map((shift) => awake(0.6, shift)),
  ...Array.from({ length: CLOD_LEFT.length }, (_, at) => digging(at)),
]

const peek = (column: number, up: boolean): Spot[] => [
  ...(up ? [[8, column, ".b."] as const, [9, column, "bkb"] as const] : [[9, column, ".b."] as const]),
  [10, column, "gbg"],
  [11, column, "ggg"],
]

const spawn = (up: boolean, dirt: Spot[]) => paint(digby(0.1), [...peek(0, up), ...peek(13, up), [12, 0, "gg"], [12, 14, "gg"], ...dirt])

const sign = (shown: boolean): Spot[] => [...(shown ? [[2, 13, "www"] as const, [3, 13, "wkw"] as const, [4, 13, "www"] as const] : []), ...post(5, 14, 7, "m")]

const waiting = (shown: boolean) => (open: boolean) => paint(digby(1, { eyes: open ? "wide" : "none" }), [[8, 4, "mm"], [8, 10, "mm"], ...sign(shown)])

const stalled = (dots: string) => () => paint(digby(0.7, { eyes: "shut", slump: true }), [[5, 0, dots]])

const report = (rise: number, spark: ReadonlyArray<string>) => (open: boolean) =>
  paint(digby(rise, { eyes: open ? "open" : "none" }), [
    [0, 12, "aaaa"],
    [1, 12, "akka"],
    [2, 12, "aaaa"],
    ...post(3, 13, 8, "m"),
    ...spark.map((row, at) => [1 + at, 0, row] as const),
  ])

export const ART: Readonly<Record<Exclude<MascotState, "idle">, ReadonlyArray<(open: boolean) => ReadonlyArray<string>>>> = {
  spawn: [
    () => spawn(true, [[3, 1, "m"], [5, 3, "m"], [2, 14, "m"], [5, 12, "m"]]),
    () => spawn(false, [[1, 0, "m"], [4, 2, "m"], [3, 15, "m"], [6, 13, "m"]]),
  ],
  running,
  waiting: [waiting(true), waiting(false)],
  stalled: [stalled("e.e.e"), stalled("e"), stalled("e.e")],
  report: [report(1, [".s.", "sss", ".s."]), report(1.25, ["s.s", ".s.", "s.s"]), report(1.1, [".s.", "sss", ".s."])],
  gone: [() => digby(-0.3, { mound: "m" })],
}

const Z_LINES = [3, 2, 1, undefined]

export function idleArt(frame?: number): ReadonlyArray<ReadonlyArray<Cell>> {
  const lines = cells(digby(-0.3, { top: frame !== undefined && breathesOut(frame) ? 8 : 6 }))
  const line = Z_LINES[(frame ?? 0) % Z_LINES.length]
  if (line === undefined) return lines
  return lines.map((cellsOf, at) => (at === line ? cellsOf.map((one, column) => (column === 13 ? { char: "z", fg: "m" as const } : one)) : cellsOf))
}

export function art(state: MascotState, frame?: number): ReadonlyArray<ReadonlyArray<Cell>> {
  if (state === "idle") return idleArt(frame)
  const frames = ART[state]
  return cells(frames[(frame ?? 0) % frames.length]!(!(frame !== undefined && OPEN_EYES.has(state) && blinks(frame))))
}
