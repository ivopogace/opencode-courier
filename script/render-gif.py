# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10.1"]
# ///
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from functools import cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_SIZE = int(os.environ.get("FONT_SIZE", 14))
FPS = int(os.environ.get("FPS", 10))
IDLE = float(os.environ.get("IDLE", 2.5))
MOTION_FPS = int(os.environ.get("MOTION_FPS", 20))
ZOOM = float(os.environ.get("ZOOM", 1.15))
TITLE = os.environ.get("TITLE", "opencode-courier: fixing two issues in parallel")
AMBER = (245, 167, 66)
BAR = (17, 17, 17)
TRACK = (74, 51, 22)
TICK = (150, 104, 44)
SHADE = 150
KEY_SHOWN = 1.4
KEY_POP = 0.15
KEY_FADE = 0.2
RIPPLE = 0.45
CLICK_SHOWN = 0.9
GLIDE = 0.3
CAPTION_TURN = 0.2
CAPTION_SLIDE = 7
ZOOM_TIME = 0.4
PROGRESS_STEP = 1.0
LOOP_HOLD = 3.0
LOOP_FADE = 0.3


def font(pattern: str, env: str) -> str:
    return os.environ.get(env) or subprocess.run(["fc-match", "-f", "%{file}", pattern], capture_output=True, text=True, check=True).stdout


@cache
def face(file: str, size: float) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(file, size)


MONO_FILE = font("DejaVu Sans Mono", "MONO_FONT")
MONO_BOLD_FILE = font("DejaVu Sans Mono:style=Bold", "MONO_BOLD_FONT")
KEY_FILE = font("DejaVu Sans:style=Bold", "KEY_FONT")
MONO = face(MONO_FILE, FONT_SIZE)
SANS = face(font("Inter:style=SemiBold", "FONT"), round(FONT_SIZE * 1.3))
ASCENT, DESCENT = MONO.getmetrics()
CELL_W, CELL_H = round(MONO.getlength("M")), ASCENT + DESCENT
PAD = CELL_W
BAR_H = round(CELL_H * 2.6)


def xterm_palette() -> list[tuple[int, int, int]]:
    base = ["000000", "cd3131", "0dbc79", "e5e510", "2472c8", "bc3fbc", "11a8cd", "e5e5e5",
            "666666", "f14c4c", "23d18b", "f5f543", "3b8eea", "d670d6", "29b8db", "ffffff"]
    colours = [tuple(int(hex[i:i + 2], 16) for i in (0, 2, 4)) for hex in base]
    steps = [0, 95, 135, 175, 215, 255]
    colours += [(steps[r], steps[g], steps[b]) for r in range(6) for g in range(6) for b in range(6)]
    colours += [(8 + 10 * i,) * 3 for i in range(24)]
    return colours


PALETTE = xterm_palette()
DEFAULT_FG, DEFAULT_BG = (212, 212, 212), (10, 10, 10)
SGR = re.compile(r"\x1b\[([0-9;:]*)m")


def colour(params: list[int], at: int) -> tuple[tuple[int, int, int] | None, int]:
    if at < len(params) and params[at] == 5 and at + 1 < len(params):
        return PALETTE[params[at + 1] % 256], at + 2
    if at < len(params) and params[at] == 2 and at + 3 < len(params):
        return (params[at + 1], params[at + 2], params[at + 3]), at + 4
    return None, at + 1


def parse(text: str, columns: int, rows: int):
    grid = []
    fg, bg, bold, dim, reverse = None, None, False, False, False
    for line in text.split("\n")[:rows]:
        cells = []
        at = 0
        for match in [*SGR.finditer(line), None]:
            chunk = line[at:match.start()] if match else line[at:]
            for char in chunk:
                if char < " ":
                    continue
                front, back = fg or DEFAULT_FG, bg or DEFAULT_BG
                if reverse:
                    front, back = back, front
                if dim:
                    front = tuple((f + b) // 2 for f, b in zip(front, back))
                cells.append((char, front, back, bold))
                if unicodedata.east_asian_width(char) in "WF":
                    cells.append(None)
            if not match:
                break
            at = match.end()
            params = [int(p) if p else 0 for p in re.split("[;:]", match.group(1))] or [0]
            i = 0
            while i < len(params):
                p = params[i]
                if p == 0:
                    fg, bg, bold, dim, reverse = None, None, False, False, False
                elif p == 1:
                    bold = True
                elif p == 2:
                    dim = True
                elif p == 22:
                    bold = dim = False
                elif p == 7:
                    reverse = True
                elif p == 27:
                    reverse = False
                elif 30 <= p <= 37 or 90 <= p <= 97:
                    fg = PALETTE[p - 30 if p < 90 else p - 82]
                elif 40 <= p <= 47 or 100 <= p <= 107:
                    bg = PALETTE[p - 40 if p < 100 else p - 92]
                elif p == 39:
                    fg = None
                elif p == 49:
                    bg = None
                elif p in (38, 48):
                    value, i = colour(params, i + 1)
                    if p == 38:
                        fg = value
                    else:
                        bg = value
                    continue
                i += 1
        while len(cells) < columns:
            cells.append((" ", fg or DEFAULT_FG, bg or DEFAULT_BG, False))
        grid.append(cells[:columns])
    while len(grid) < rows:
        grid.append([(" ", DEFAULT_FG, DEFAULT_BG, False)] * columns)
    return grid


BOX = {
    "─": (0, 1, 0, 1), "━": (0, 2, 0, 2), "│": (1, 0, 1, 0), "┃": (2, 0, 2, 0),
    "┌": (0, 1, 1, 0), "┐": (0, 0, 1, 1), "└": (1, 1, 0, 0), "┘": (1, 0, 0, 1),
    "╭": (0, 1, 1, 0), "╮": (0, 0, 1, 1), "╰": (1, 1, 0, 0), "╯": (1, 0, 0, 1),
    "├": (1, 1, 1, 0), "┤": (1, 0, 1, 1), "┬": (0, 1, 1, 1), "┴": (1, 1, 0, 1), "┼": (1, 1, 1, 1),
    "┏": (0, 2, 2, 0), "┓": (0, 0, 2, 2), "┗": (2, 2, 0, 0), "┛": (2, 0, 0, 2),
    "╹": (2, 0, 0, 0), "╻": (0, 0, 2, 0), "╵": (1, 0, 0, 0), "╷": (0, 0, 1, 0),
}
QUADRANTS = {
    "▀": (1, 1, 0, 0), "▄": (0, 0, 1, 1), "█": (1, 1, 1, 1), "▌": (1, 0, 1, 0), "▐": (0, 1, 0, 1),
    "▘": (1, 0, 0, 0), "▝": (0, 1, 0, 0), "▖": (0, 0, 1, 0), "▗": (0, 0, 0, 1), "▚": (1, 0, 0, 1), "▞": (0, 1, 1, 0),
    "▛": (1, 1, 1, 0), "▜": (1, 1, 0, 1), "▙": (1, 0, 1, 1), "▟": (0, 1, 1, 1),
}
SHADES = {"░": 0.25, "▒": 0.5, "▓": 0.75}


def draw_cell(draw: ImageDraw.ImageDraw, left: int, top: int, right: int, bottom: int, unit: int, cell, scale: float):
    char, fg, bg, bold = cell
    tall = bottom - top
    draw.rectangle([left, top, right - 1, bottom - 1], fill=bg)
    if char == " ":
        return
    if char in QUADRANTS:
        half_w, half_h = unit // 2, tall // 2
        for (dx, dy, w, h), on in zip([(0, 0, half_w, half_h), (half_w, 0, unit - half_w, half_h),
                                       (0, half_h, half_w, tall - half_h), (half_w, half_h, unit - half_w, tall - half_h)],
                                      QUADRANTS[char]):
            if on:
                draw.rectangle([left + dx, top + dy, left + dx + w - 1, top + dy + h - 1], fill=fg)
    elif char in SHADES:
        share = SHADES[char]
        draw.rectangle([left, top, left + unit - 1, bottom - 1], fill=tuple(round(f * share + b * (1 - share)) for f, b in zip(fg, bg)))
    elif char in BOX:
        mid_x, mid_y = left + unit // 2, top + tall // 2
        for (to_x, to_y), weight in zip([(mid_x, top), (left + unit, mid_y), (mid_x, bottom), (left, mid_y)], BOX[char]):
            if weight:
                thick = max(1, round((1 if weight == 1 else 3) * scale))
                if to_x == mid_x:
                    draw.rectangle([mid_x - thick // 2, min(mid_y, to_y), mid_x - thick // 2 + thick - 1, max(mid_y, to_y)], fill=fg)
                else:
                    draw.rectangle([min(mid_x, to_x), mid_y - thick // 2, max(mid_x, to_x), mid_y - thick // 2 + thick - 1], fill=fg)
    elif 0x2800 <= ord(char) <= 0x28FF:
        bits = ord(char) - 0x2800
        dots = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3)]
        dot = max(1, round(scale))
        for bit, (column, row) in enumerate(dots):
            if bits >> bit & 1:
                cx, cy = left + unit * (1 + 2 * column) // 4, top + tall * (1 + 2 * row) // 8
                draw.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=fg)
    else:
        draw.text((left, top), char, font=face(MONO_BOLD_FILE if bold else MONO_FILE, FONT_SIZE * scale), fill=fg)


def draw_screen(grid, cursor, scale: float = 1) -> Image.Image:
    xs = [round(column * CELL_W * scale) for column in range(len(grid[0]) + 1)]
    ys = [round(row * CELL_H * scale) for row in range(len(grid) + 1)]
    image = Image.new("RGB", (xs[-1], ys[-1]), DEFAULT_BG)
    draw = ImageDraw.Draw(image)
    for row, cells in enumerate(grid):
        for column, cell in enumerate(cells):
            if cell is None:
                continue
            wide = column + 1 < len(cells) and cells[column + 1] is None
            draw_cell(draw, xs[column], ys[row], xs[column + (2 if wide else 1)], ys[row + 1], xs[column + 1] - xs[column], cell, scale)
    if cursor:
        column, row = cursor
        if row < len(grid) and column < len(grid[row]) and grid[row][column]:
            char, fg, bg, bold = grid[row][column]
            draw_cell(draw, xs[column], ys[row], xs[column + 1], ys[row + 1], xs[column + 1] - xs[column], (char, bg, fg, bold), scale)
    return image


def read_recording(folder: Path):
    size = json.loads((folder / "size.json").read_text())
    frames = []
    for path in sorted((folder / "frames").glob("*.ans"), key=lambda one: int(one.stem)):
        head, _, body = path.read_text(encoding="utf-8", errors="replace").partition("\n")
        x, y, shown = (head.split() + ["0", "0", "0"])[:3]
        key = (body, x, y, shown)
        if frames and frames[-1][1] == key:
            continue
        frames.append((int(path.stem) / 1000, key))
    marks = []
    for line in (folder / "marks.tsv").read_text(encoding="utf-8").splitlines():
        at, _, label = line.partition("\t")
        marks.append((int(at) / 1000, label))
    return size, frames, marks


def squeeze(times: list[float], start: float):
    points = sorted({start, *[t for t in times if t >= start]})
    out = [0.0]
    for before, after in zip(points, points[1:]):
        out.append(out[-1] + min(after - before, IDLE))

    def moved(time: float) -> float:
        if time <= points[0]:
            return 0.0
        for index in range(1, len(points)):
            if time <= points[index]:
                return out[index - 1] + min(time - points[index - 1], IDLE)
        return out[-1] + min(time - points[-1], IDLE)

    return moved


def clamp(share: float) -> float:
    return min(1.0, max(0.0, share))


def ease(share: float) -> float:
    share = clamp(share)
    return share * share * (3 - 2 * share)


def settle(share: float) -> float:
    return 1 - (1 - clamp(share)) ** 3


def mix(before: float, after: float, share: float) -> float:
    return before + (after - before) * share


def blend(back, front, share: float):
    return tuple(round(mix(b, f, share)) for b, f in zip(back, front))


class Glide:
    def __init__(self, value, seconds: float):
        self.turns = [(float("-inf"), value, value)]
        self.seconds = seconds

    def at(self, time: float):
        since, before, after = next(turn for turn in reversed(self.turns) if turn[0] <= time)
        share = ease((time - since) / self.seconds) if since > float("-inf") else 1.0
        return tuple(mix(a, b, share) for a, b in zip(before, after))

    def heading(self, time: float):
        return next(turn for turn in reversed(self.turns) if turn[0] <= time)[2]

    def to(self, time: float, value, start=None):
        self.turns.append((time, start or self.at(time), value))


class Story:
    def __init__(self, marks, moved, start: float, length: float, width: int, height: int):
        self.length, self.width, self.height = length, width, height
        self.captions, self.keys, self.clicks, self.scenes = [(float("-inf"), TITLE)], [], [], []
        self.spot = Glide((0.0, 0.0, float(width), float(height - BAR_H), 0.0), GLIDE)
        self.zoom = Glide((1.0,), ZOOM_TIME)
        for at, label in marks:
            if at < start:
                continue
            time = moved(at)
            kind, _, rest = label.partition(" ")
            if kind == "caption":
                self.captions.append((time, rest))
            elif kind == "key":
                self.keys.append((time, rest))
            elif kind == "click":
                self.clicks.append((time, tuple(int(n) for n in rest.split())))
            elif kind == "zoom":
                self.zoom.to(time, (ZOOM if rest == "on" else 1.0,))
            elif kind == "focus" and rest != "off":
                self.light(time, *(int(n) for n in rest.split()))
            else:
                if kind != "focus":
                    self.scenes.append(time)
                    self.zoom.to(time, (1.0,))
                self.spot.to(time, (*self.spot.at(time)[:4], 0.0))

    def light(self, time: float, column: int, row: int, wide: int, tall: int):
        left = max(4, PAD + (column - 1) * CELL_W - 4)
        top = max(4, PAD + (row - 1) * CELL_H - 3)
        right = min(self.width - 5, PAD + (column - 1 + wide) * CELL_W + 4)
        bottom = min(self.height - BAR_H - 5, PAD + (row - 1 + tall) * CELL_H + 3)
        lit = self.spot.at(time)[4] > 0.05
        self.spot.to(time, (left, top, right, bottom, 1.0), None if lit else (left - 10, top - 10, right + 10, bottom + 10, 0.0))

    def caption(self, time: float):
        index = max(i for i, (at, _) in enumerate(self.captions) if at <= time)
        share = clamp((time - self.captions[index][0]) / CAPTION_TURN) if index else 1.0
        if share < 0.5:
            out = ease(share * 2)
            return self.captions[index - 1][1], round(1 - out, 2), -round(CAPTION_SLIDE * out)
        into = settle(share * 2 - 1)
        return self.captions[index][1], round(into, 2), round(CAPTION_SLIDE * (1 - into))

    def key(self, time: float):
        shown = [(at, label) for at, label in self.keys if at <= time < at + KEY_SHOWN]
        if not shown:
            return None
        at, label = shown[-1]
        age = time - at
        pop = settle(age / KEY_POP)
        ripple = clamp(age / RIPPLE)
        return (label, round(0.85 + 0.15 * pop, 2), round(min(pop, clamp((KEY_SHOWN - age) / KEY_FADE)), 2),
                round(7 * settle(ripple)), round(0.8 * (1 - ripple), 2))

    def click(self, time: float):
        shown = [(at, cell) for at, cell in self.clicks if at <= time < at + CLICK_SHOWN]
        if not shown:
            return None
        at, cell = shown[-1]
        age = time - at
        ripple = clamp(age / RIPPLE)
        return cell, round(6 + 18 * settle(ripple)), round(1 - ripple, 2), round(clamp((CLICK_SHOWN - age) / KEY_FADE), 2)

    def look(self, time: float):
        left, top, right, bottom, lit = self.spot.at(time)
        shade = self.spot.heading(time)[4]
        scale = round(self.zoom.at(time)[0], 3) if lit > 0.004 else 1.0
        reached = self.length if time + 1 / FPS > self.length else int(time / PROGRESS_STEP) * PROGRESS_STEP
        return (scale, (round(left), round(top), round(right), round(bottom)) if lit > 0.004 else None, shade, round(lit, 2),
                self.caption(time), self.key(time), self.click(time), round(self.width * clamp(reached / self.length)))

    def draw(self, screen, look) -> Image.Image:
        scale, spot, shade, lit, (caption, caption_share, caption_dy), key, click, reached = look
        width, height = self.width, self.height
        canvas = Image.new("RGB", (width, height), DEFAULT_BG)
        canvas.paste(screen(1), (PAD, PAD))
        if spot:
            left, top, right, bottom = spot
            if scale != 1:
                wide, tall = round((right - left) * scale), round((bottom - top) * scale)
                lens = Image.new("RGB", (wide + 1, tall + 1), DEFAULT_BG)
                lens.paste(screen(scale), (-round((left - PAD) * scale), -round((top - PAD) * scale)))
                left = min(max(7, round((left + right - wide) / 2)), width - 8 - wide)
                top = min(max(7, round((top + bottom - tall) / 2)), height - BAR_H - 8 - tall)
                right, bottom = left + wide, top + tall
                canvas.paste(lens, (left, top))
            if shade:
                dark = Image.new("L", canvas.size, round(SHADE * shade))
                ImageDraw.Draw(dark).rectangle([left, top, right, bottom], fill=0)
                canvas.paste((0, 0, 0), (0, 0), dark)
            ring = Image.new("L", canvas.size, 0)
            ImageDraw.Draw(ring).rounded_rectangle([left - 3, top - 3, right + 3, bottom + 3], radius=5, outline=round(255 * lit), width=3)
            canvas.paste(AMBER, (0, 0), ring)
        draw = ImageDraw.Draw(canvas)
        if click:
            (column, row), reach, ripple, shown = click
            x, y = PAD + (column - 1) * CELL_W + CELL_W // 2, PAD + (row - 1) * CELL_H + CELL_H // 2
            if ripple > 0:
                ring = Image.new("L", canvas.size, 0)
                ImageDraw.Draw(ring).ellipse([x - reach, y - reach, x + reach, y + reach], outline=round(255 * ripple), width=3)
                canvas.paste(AMBER, (0, 0), ring)
            arrow = [(0, 0), (0, 17), (4, 13), (7, 20), (10, 19), (7, 12), (12, 12)]
            pointer = Image.new("L", canvas.size, 0)
            ImageDraw.Draw(pointer).polygon([(x + 2 + dx, y + 2 + dy) for dx, dy in arrow], fill=round(255 * shown))
            canvas.paste((255, 255, 255), (0, 0), pointer)
            edge = Image.new("L", canvas.size, 0)
            ImageDraw.Draw(edge).polygon([(x + 2 + dx, y + 2 + dy) for dx, dy in arrow], outline=round(255 * shown))
            canvas.paste((0, 0, 0), (0, 0), edge)
        top = height - BAR_H
        draw.rectangle([0, top, width, height], fill=BAR)
        draw.rectangle([0, top, width, top + 2], fill=AMBER)
        caption_right = width - PAD
        if key:
            label, grown, shown, reach, ripple = key
            label_w = draw.textlength(label, font=face(KEY_FILE, round(FONT_SIZE * 1.15)))
            box_w, box_h = max(label_w + 24, BAR_H - 20), BAR_H - 22
            mid_x, mid_y = width - PAD - box_w / 2, top + 12 + box_h / 2
            caption_right = width - 2 * PAD - box_w
            if ripple > 0 and reach > 0:
                draw.rounded_rectangle([mid_x - box_w / 2 - reach, mid_y - box_h / 2 - reach, mid_x + box_w / 2 + reach, mid_y + box_h / 2 + reach],
                                       radius=7 + reach, outline=blend(BAR, AMBER, ripple), width=2)
            half_w, half_h = box_w * grown / 2, box_h * grown / 2
            draw.rounded_rectangle([mid_x - half_w, mid_y - half_h, mid_x + half_w, mid_y + half_h], radius=7,
                                   fill=blend(BAR, (58, 58, 58), shown), outline=blend(BAR, AMBER, shown), width=2)
            draw.text((mid_x, mid_y), label, font=face(KEY_FILE, round(FONT_SIZE * 1.15 * grown, 1)), fill=blend(BAR, (255, 255, 255), shown), anchor="mm")
        text = caption
        while draw.textlength(text, font=SANS) > caption_right - 2 * PAD and len(text) > 1:
            text = text[:-2] + "…"
        draw.text((PAD * 2, top + 2 + (BAR_H - 2) / 2 + caption_dy), text, font=SANS, fill=blend(BAR, (255, 255, 255), caption_share), anchor="lm")
        draw.rectangle([0, height - 3, width, height], fill=TRACK)
        draw.rectangle([0, height - 3, reached, height], fill=AMBER)
        for at in self.scenes:
            x = round(width * at / self.length)
            draw.rectangle([x, height - 7, x + 1, height], fill=AMBER if x <= reached else TICK)
        return canvas


def main():
    folder, out = Path(sys.argv[1]), Path(sys.argv[2])
    size, frames, marks = read_recording(folder)
    columns, rows = size["columns"], size["rows"]
    scenes = [at for at, label in marks if not re.match(r"(focus|caption|key|click|zoom) ", label)]
    start = (scenes[0] if scenes else frames[0][0]) - 2.0
    end = max(frames[-1][0], marks[-1][0]) if marks else frames[-1][0]
    moved = squeeze([at for at, _ in frames] + [at for at, _ in marks], start)
    length = moved(end)
    story = Story(marks, moved, start, length, columns * CELL_W + 2 * PAD, rows * CELL_H + 2 * PAD + BAR_H)
    fine = max(1, round(MOTION_FPS / FPS))
    shown = [(moved(at), index) for index, (at, _) in enumerate(frames) if at >= start]
    first = max((index for index, (at, _) in enumerate(frames) if at <= start), default=0)

    def screen_at(time: float) -> int:
        return max((index for at, index in shown if at <= time), default=first)

    drawn: dict[tuple[int, float], Image.Image] = {}

    def screen(index: int, scale: float) -> Image.Image:
        if (index, scale) not in drawn:
            if len(drawn) > 3:
                drawn.clear()
            body, x, y, cursor = frames[index][1]
            drawn[index, scale] = draw_screen(parse(body, columns, rows), (int(x), int(y)) if cursor == "1" else None, scale)
        return drawn[index, scale]

    with tempfile.TemporaryDirectory() as work:
        listing, last, opening, closing = [], None, None, None
        for step in range((int(length * FPS) + 1) * fine):
            state = (screen_at(step // fine / FPS), story.look(step / fine / FPS))
            if state == last:
                listing[-1][1] += 1 / FPS / fine
                continue
            last = state
            closing = story.draw(lambda scale, index=state[0]: screen(index, scale), state[1])
            opening = opening or closing
            path = Path(work) / f"{len(listing):05d}.png"
            closing.save(path)
            listing.append([path, 1 / FPS / fine])
        listing[-1][1] += LOOP_HOLD
        fades = round(LOOP_FADE * FPS)
        for fade in range(1, fades + 1):
            path = Path(work) / f"{len(listing):05d}.png"
            Image.blend(closing, opening, ease(fade / (fades + 1))).save(path)
            listing.append([path, 1 / FPS])
        concat = Path(work) / "frames.txt"
        concat.write_text("".join(f"file '{path}'\nduration {seconds:.3f}\n" for path, seconds in listing) + f"file '{listing[-1][0]}'\n")
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
             "-vf", "split[a][b];[a]palettegen=stats_mode=diff:max_colors=192[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
             "-fps_mode", "vfr", "-loop", "0", str(out)],
            check=True,
        )
    seconds = sum(one[1] for one in listing)
    print(f"wrote {out} ({len(listing)} frames, {seconds:.0f} s, {out.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
