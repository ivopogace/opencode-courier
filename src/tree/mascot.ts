/**
 * A pixel of Digby, the tree panel's mole, as the theme colour it takes: `b` body, `k` background (eyes), `g` mound,
 * `m` muted (paws, dirt, post, arm), `a` accent (snout, letter), `w`, `e` and `s` warning, error and success (sign, dots, spark).
 */
export type Token = "b" | "k" | "g" | "m" | "a" | "w" | "e" | "s"

/** What Digby shows: the tree's state, or for a while after one arrives, a spawn or a report. */
export type MascotState = "idle" | "spawn" | "running" | "waiting" | "stalled" | "report" | "gone"

/** One cell of a drawing: `▀` the top pixel's colour over the bottom's, `▄` only a bottom pixel, `█` both alike, or a character. */
export type Cell = { readonly char: string; readonly fg?: Token; readonly bg?: Token }

/** Digby's frames take one panel frame in this many, about every 450 ms. */
export const MASCOT_EVERY = 5

/** He blinks on every this-many-th of his frames where his eyes are open. */
export const BLINK_EVERY = 11

/**
 * The 8×4 glyph's frames by state, pixel rows top to bottom; a state with several cycles through them, one per mascot frame.
 * No muted pixel touches the mound, here or in the 16×16, as `text.muted` is close to `background.raised.max`.
 */
export const GLYPH: Readonly<Record<MascotState, ReadonlyArray<ReadonlyArray<string>>>> = {
  idle: [["........", "........", "..gggg..", "gggggggg"]],
  spawn: [
    ["........", "...bb...", "g.bbbb.g", "gggggggg"],
    [".g....g.", "...bb...", "ggbbbbgg", "gggggggg"],
  ],
  running: [
    ["..g..g..", "...bb...", ".gbbbbg.", "gggggggg"],
    [".g....g.", "........", ".gbbbbg.", "gggggggg"],
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

/** The states in which his eyes are open, so he blinks. */
const OPEN_EYES: ReadonlySet<MascotState> = new Set(["waiting", "report"])

/** The 8×4 glyph's pixels for `state` at mascot frame `frame`, its first frame with none: animations off. */
export function glyph(state: MascotState, frame?: number): ReadonlyArray<string> {
  const frames = GLYPH[state]
  const pixels = frames[(frame ?? 0) % frames.length]!
  if (frame === undefined) return pixels
  if (state === "idle" && breathesOut(frame)) return [...pixels.slice(0, 2), ".gggggg.", ...pixels.slice(3)]
  return OPEN_EYES.has(state) && blinks(frame) ? pixels.map((row) => row.replaceAll("k", "b")) : pixels
}

/** The mound's top row widens for two frames in four. */
const breathesOut = (frame: number) => Math.floor(frame / 2) % 2 === 1

const blinks = (frame: number) => frame % BLINK_EVERY === BLINK_EVERY - 1

/** Pixel rows, two to a line of cells, by the half-block rule; an odd last row has nothing under it. */
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

/** The 16×16's size, in pixels. */
const SIZE = 16

/** How his eyes are drawn: one pixel each, `wide` two tall, `shut` two wide, or `none` (blinking). */
export type Eyes = "open" | "wide" | "shut" | "none"

/** How far each of the head's rows leans right when he slumps. */
const SLUMP = [2, 2, 2, 1, 1, 0, 0]

/**
 * The 16×16 Digby, his head raised by `rise` (0 in the hole, 1 fully up; below 0 out of sight) over a body in the hole,
 * then the mound (its top row `top` wide, `shift` columns over) and the ground, both `mound`, drawn over it but for the hole.
 */
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

/** A spot of `pixels` with its first at row `row`, column `column`; `.` leaves what is under it. */
type Spot = readonly [row: number, column: number, pixels: string]

/** `pixels` with `spots` drawn over them. */
export function paint(pixels: ReadonlyArray<string>, spots: ReadonlyArray<Spot>): ReadonlyArray<string> {
  const grid = pixels.map((row) => [...row])
  for (const [row, column, drawn] of spots)
    [...drawn].forEach((pixel, at) => {
      if (pixel !== "." && grid[row]?.[column + at] !== undefined) grid[row]![column + at] = pixel
    })
  return grid.map((row) => row.join(""))
}

/** A column of `length` pixels of `pixel` from row `row`. */
const post = (row: number, column: number, length: number, pixel: string): Spot[] =>
  Array.from({ length }, (_, at) => [row + at, column, pixel] as const)

/** The head's top row at `rise`, where running's snout pokes up. */
const headTop = (rise: number) => Math.round(10 - 8 * rise)

const running = (rise: number, shift: number, dirt: Spot[]) => paint(digby(rise, { shift }), [[headTop(rise), 7, "aa"], ...dirt])

/** A child's head peeking out of a side mound at columns `column`–`column + 2`, `up` or half sunk. */
const peek = (column: number, up: boolean): Spot[] => [
  ...(up ? [[8, column, ".b."] as const, [9, column, "bkb"] as const] : [[9, column, ".b."] as const]),
  [10, column, "gbg"],
  [11, column, "ggg"],
]

const spawn = (up: boolean, dirt: Spot[]) => paint(digby(0.1), [...peek(0, up), ...peek(13, up), [12, 0, "gg"], [12, 14, "gg"], ...dirt])

/** The sign on its post, which stops a pixel above the ground so the muted post does not sit on it. */
const sign = (shown: boolean): Spot[] => [...(shown ? [[2, 13, "www"] as const, [3, 13, "wkw"] as const, [4, 13, "www"] as const] : []), ...post(5, 14, 7, "m")]

/** His paws, held a pixel above the mound's rim so the muted pixels do not touch it. */
const waiting = (shown: boolean) => (open: boolean) => paint(digby(1, { eyes: open ? "wide" : "none" }), [[8, 4, "mm"], [8, 10, "mm"], ...sign(shown)])

const stalled = (dots: string) => () => paint(digby(0.7, { eyes: "shut", slump: true }), [[5, 0, dots]])

/** The letter held up on his arm, which stops a pixel above the mound so it does not touch it, and the spark beside him. */
const report = (rise: number, spark: ReadonlyArray<string>) => (open: boolean) =>
  paint(digby(rise, { eyes: open ? "open" : "none" }), [
    [0, 12, "aaaa"],
    [1, 12, "akka"],
    [2, 12, "aaaa"],
    ...post(3, 13, 8, "m"),
    ...spark.map((row, at) => [1 + at, 0, row] as const),
  ])

/** The 16×16's frames by state but idle, each its pixels with the eyes open or, for a blink, not; the first reads alone. */
export const ART: Readonly<Record<Exclude<MascotState, "idle">, ReadonlyArray<(open: boolean) => ReadonlyArray<string>>>> = {
  spawn: [
    () => spawn(true, [[3, 1, "m"], [5, 3, "m"], [2, 14, "m"], [5, 12, "m"]]),
    () => spawn(false, [[1, 0, "m"], [4, 2, "m"], [3, 15, "m"], [6, 13, "m"]]),
  ],
  running: [
    () => running(0.22, 0, [[5, 2, "m"], [7, 1, "m"], [4, 13, "m"], [6, 14, "m"]]),
    () => running(0.12, 1, [[3, 1, "m"], [6, 3, "m"], [5, 12, "m"], [3, 15, "m"]]),
  ],
  waiting: [waiting(true), waiting(false)],
  stalled: [stalled("e.e.e"), stalled("e"), stalled("e.e")],
  report: [report(1, [".s.", "sss", ".s."]), report(1.25, ["s.s", ".s.", "s.s"]), report(1.1, [".s.", "sss", ".s."])],
  gone: [() => digby(-0.3, { mound: "m" })],
}

/** Where idle's `z` drifts up, by cell line, one step per mascot frame, then gone a frame. */
const Z_LINES = [3, 2, 1, undefined]

/** The 16×16 idle Digby at mascot frame `frame`, its first with none: the mound breathing, a `z` drifting up beside it. */
export function idleArt(frame?: number): ReadonlyArray<ReadonlyArray<Cell>> {
  const lines = cells(digby(-0.3, { top: frame !== undefined && breathesOut(frame) ? 8 : 6 }))
  const line = Z_LINES[(frame ?? 0) % Z_LINES.length]
  if (line === undefined) return lines
  return lines.map((cellsOf, at) => (at === line ? cellsOf.map((one, column) => (column === 13 ? { char: "z", fg: "m" as const } : one)) : cellsOf))
}

/** The 16×16 Digby for `state` at mascot frame `frame`, its first frame with none: animations off. */
export function art(state: MascotState, frame?: number): ReadonlyArray<ReadonlyArray<Cell>> {
  if (state === "idle") return idleArt(frame)
  const frames = ART[state]
  return cells(frames[(frame ?? 0) % frames.length]!(!(frame !== undefined && OPEN_EYES.has(state) && blinks(frame))))
}
