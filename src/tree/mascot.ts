/**
 * Digby, the tree panel's mole, in half-block pixels: one terminal cell is a column of two pixels. Each pixel is a token
 * the panel colours from its theme, `.` none: `b` body, `k` the background (eyes), `g` mound, `m` muted (paws, dirt, arm),
 * `a` the accent (snout, letter), `w`, `e` and `s` the warning, error and success colours (sign, dots, spark).
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

/** The 8×4 glyph's frames by state, pixel rows top to bottom; a state with several cycles through them, one per mascot frame. */
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
    [".bbbbbbw", ".bkbbkbw", ".bbaabbm", "gggggggg"],
    [".bbbbbbb", ".bkbbkbb", ".bbaabbm", "gggggggg"],
  ],
  stalled: [
    ["..e.....", ".bbbbbb.", ".bkbbkb.", "gbbaabbg"],
    ["..e.e...", ".bbbbbb.", ".bkbbkb.", "gbbaabbg"],
    ["..e.e.e.", ".bbbbbb.", ".bkbbkb.", "gbbaabbg"],
  ],
  report: [
    ["......aa", "bbbbbbaa", "bkbbkbm.", "bbaabbmg"],
    ["s.....aa", "bbbbbbaa", "bkbbkbm.", "bbaabbmg"],
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

/**
 * The 16×16 Digby, his head raised by `rise` (0 in the hole, 1 fully up; below 0 out of sight): a 7-row head in columns
 * 4–11, then the mound (its top row `top` wide, 6 or 8 as he breathes) and the ground drawn over it, but for the hole.
 */
export function digby(rise: number, { top = 6, eyes = true }: { top?: number; eyes?: boolean } = {}): ReadonlyArray<string> {
  const grid = Array.from({ length: SIZE }, () => new Array<string>(SIZE).fill("."))
  const span = (row: number, width: number, pixel: string, skip = (_column: number) => false) => {
    if (row < 0 || row >= SIZE) return
    for (let column = (SIZE - width) / 2; column < (SIZE + width) / 2; column++) if (!skip(column)) grid[row]![column] = pixel
  }
  const head = Math.round(10 - 8 * rise)
  ;[4, 6, 8, 8, 8, 6, 4].forEach((width, at) => span(head + at, width, "b"))
  if (eyes) span(head + 3, 4, "k", (column) => column !== 6 && column !== 9)
  span(head + 4, 2, "a")
  span(10, top, "g", (column) => column >= 6 && column <= 9)
  span(11, 10, "g")
  span(12, 12, "g")
  for (const row of [13, 14, 15]) span(row, SIZE, "g")
  return grid.map((row) => row.join(""))
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
