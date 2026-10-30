# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10"]
# ///
"""Renders a recording from script/record-gif.sh as the README's GIF, a caption under the screen and the viewer's eye led:

    uv run script/render-gif.py <recording dir> <out.gif>

Draws each screen tmux kept, its colours and cursor, with the highlights dimming the rest, each key pressed and each
click, and the captions, then has ffmpeg encode the GIF. Settings: docs/maintainers/development.md."""
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_SIZE = int(os.environ.get("FONT_SIZE", 14))
FPS = int(os.environ.get("FPS", 10))
IDLE = float(os.environ.get("IDLE", 2.5))
TITLE = os.environ.get("TITLE", "opencode-courier: an orchestrator, its leads and their workers")
AMBER = (245, 167, 66)
BAR = (17, 17, 17)
SHADE = 150
KEY_SHOWN = 1.4
CLICK_SHOWN = 0.9


def font(pattern: str, env: str) -> str:
    return os.environ.get(env) or subprocess.run(["fc-match", "-f", "%{file}", pattern], capture_output=True, text=True, check=True).stdout


MONO = ImageFont.truetype(font("DejaVu Sans Mono", "MONO_FONT"), FONT_SIZE)
MONO_BOLD = ImageFont.truetype(font("DejaVu Sans Mono:style=Bold", "MONO_BOLD_FONT"), FONT_SIZE)
SANS = ImageFont.truetype(font("Inter:style=SemiBold", "FONT"), round(FONT_SIZE * 1.3))
KEY = ImageFont.truetype(font("DejaVu Sans:style=Bold", "KEY_FONT"), round(FONT_SIZE * 1.15))
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
    """The colour a 38 or 48 at params[at - 1] names, and the index after it."""
    if at < len(params) and params[at] == 5 and at + 1 < len(params):
        return PALETTE[params[at + 1] % 256], at + 2
    if at < len(params) and params[at] == 2 and at + 3 < len(params):
        return (params[at + 1], params[at + 2], params[at + 3]), at + 4
    return None, at + 1


def parse(text: str, columns: int, rows: int):
    """A screen's cells, row by row: (character, foreground, background, bold), wide characters followed by None."""
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
        # The rest of a line tmux trimmed keeps the colours it ended with.
        while len(cells) < columns:
            cells.append((" ", fg or DEFAULT_FG, bg or DEFAULT_BG, False))
        grid.append(cells[:columns])
    while len(grid) < rows:
        grid.append([(" ", DEFAULT_FG, DEFAULT_BG, False)] * columns)
    return grid


# Box drawing as strokes up, right, down and left: 1 light, 2 heavy.
BOX = {
    "─": (0, 1, 0, 1), "━": (0, 2, 0, 2), "│": (1, 0, 1, 0), "┃": (2, 0, 2, 0),
    "┌": (0, 1, 1, 0), "┐": (0, 0, 1, 1), "└": (1, 1, 0, 0), "┘": (1, 0, 0, 1),
    "╭": (0, 1, 1, 0), "╮": (0, 0, 1, 1), "╰": (1, 1, 0, 0), "╯": (1, 0, 0, 1),
    "├": (1, 1, 1, 0), "┤": (1, 0, 1, 1), "┬": (0, 1, 1, 1), "┴": (1, 1, 0, 1), "┼": (1, 1, 1, 1),
    "┏": (0, 2, 2, 0), "┓": (0, 0, 2, 2), "┗": (2, 2, 0, 0), "┛": (2, 0, 0, 2),
    "╹": (2, 0, 0, 0), "╻": (0, 0, 2, 0), "╵": (1, 0, 0, 0), "╷": (0, 0, 1, 0),
}
# Block elements as the quadrants they fill: top left, top right, bottom left, bottom right.
QUADRANTS = {
    "▀": (1, 1, 0, 0), "▄": (0, 0, 1, 1), "█": (1, 1, 1, 1), "▌": (1, 0, 1, 0), "▐": (0, 1, 0, 1),
    "▘": (1, 0, 0, 0), "▝": (0, 1, 0, 0), "▖": (0, 0, 1, 0), "▗": (0, 0, 0, 1), "▚": (1, 0, 0, 1), "▞": (0, 1, 1, 0),
    "▛": (1, 1, 1, 0), "▜": (1, 1, 0, 1), "▙": (1, 0, 1, 1), "▟": (0, 1, 1, 1),
}
SHADES = {"░": 0.25, "▒": 0.5, "▓": 0.75}


def draw_cell(draw: ImageDraw.ImageDraw, x: int, y: int, cell, width: int):
    char, fg, bg, bold = cell
    draw.rectangle([x, y, x + width - 1, y + CELL_H - 1], fill=bg)
    if char == " ":
        return
    if char in QUADRANTS:
        half_w, half_h = CELL_W // 2, CELL_H // 2
        for (dx, dy, w, h), on in zip([(0, 0, half_w, half_h), (half_w, 0, CELL_W - half_w, half_h),
                                       (0, half_h, half_w, CELL_H - half_h), (half_w, half_h, CELL_W - half_w, CELL_H - half_h)],
                                      QUADRANTS[char]):
            if on:
                draw.rectangle([x + dx, y + dy, x + dx + w - 1, y + dy + h - 1], fill=fg)
    elif char in SHADES:
        share = SHADES[char]
        draw.rectangle([x, y, x + CELL_W - 1, y + CELL_H - 1], fill=tuple(round(f * share + b * (1 - share)) for f, b in zip(fg, bg)))
    elif char in BOX:
        mid_x, mid_y = x + CELL_W // 2, y + CELL_H // 2
        for (to_x, to_y), weight in zip([(mid_x, y), (x + CELL_W, mid_y), (mid_x, y + CELL_H), (x, mid_y)], BOX[char]):
            if weight:
                thick = 1 if weight == 1 else 3
                if to_x == mid_x:
                    draw.rectangle([mid_x - thick // 2, min(mid_y, to_y), mid_x - thick // 2 + thick - 1, max(mid_y, to_y)], fill=fg)
                else:
                    draw.rectangle([min(mid_x, to_x), mid_y - thick // 2, max(mid_x, to_x), mid_y - thick // 2 + thick - 1], fill=fg)
    elif 0x2800 <= ord(char) <= 0x28FF:
        bits = ord(char) - 0x2800
        dots = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3)]
        for bit, (column, row) in enumerate(dots):
            if bits >> bit & 1:
                cx, cy = x + CELL_W * (1 + 2 * column) // 4, y + CELL_H * (1 + 2 * row) // 8
                draw.ellipse([cx - 1, cy - 1, cx + 1, cy + 1], fill=fg)
    else:
        draw.text((x, y), char, font=MONO_BOLD if bold else MONO, fill=fg)


def draw_screen(grid, cursor) -> Image.Image:
    image = Image.new("RGB", (len(grid[0]) * CELL_W, len(grid) * CELL_H), DEFAULT_BG)
    draw = ImageDraw.Draw(image)
    for row, cells in enumerate(grid):
        for column, cell in enumerate(cells):
            if cell is None:
                continue
            wide = column + 1 < len(cells) and cells[column + 1] is None
            draw_cell(draw, column * CELL_W, row * CELL_H, cell, CELL_W * (2 if wide else 1))
    if cursor:
        column, row = cursor
        if row < len(grid) and column < len(grid[row]) and grid[row][column]:
            char, fg, bg, bold = grid[row][column]
            draw_cell(draw, column * CELL_W, row * CELL_H, (char, bg, fg, bold), CELL_W)
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
    """Maps a time of the recording to the GIF's, every pause between two changes cut to IDLE."""
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


def overlay(image: Image.Image, columns: int, caption: str, focus, key, click, since_click: float) -> Image.Image:
    width, height = columns * CELL_W + 2 * PAD, image.height + 2 * PAD + BAR_H
    canvas = Image.new("RGB", (width, height), DEFAULT_BG)
    canvas.paste(image, (PAD, PAD))
    if focus:
        column, row, wide, tall = focus
        left, top = PAD + (column - 1) * CELL_W - 4, PAD + (row - 1) * CELL_H - 3
        right, bottom = PAD + (column - 1 + wide) * CELL_W + 4, PAD + (row - 1 + tall) * CELL_H + 3
        shade = Image.new("L", canvas.size, SHADE)
        ImageDraw.Draw(shade).rectangle([left, top, right, bottom], fill=0)
        canvas.paste((0, 0, 0), (0, 0), shade)
        ImageDraw.Draw(canvas).rounded_rectangle([left - 3, top - 3, right + 3, bottom + 3], radius=5, outline=AMBER, width=3)
    draw = ImageDraw.Draw(canvas)
    if click:
        x, y = PAD + (click[0] - 1) * CELL_W + CELL_W // 2, PAD + (click[1] - 1) * CELL_H + CELL_H // 2
        ring = 6 + since_click / CLICK_SHOWN * 18
        draw.ellipse([x - ring, y - ring, x + ring, y + ring], outline=AMBER, width=3)
        arrow = [(0, 0), (0, 17), (4, 13), (7, 20), (10, 19), (7, 12), (12, 12)]
        draw.polygon([(x + 2 + dx, y + 2 + dy) for dx, dy in arrow], fill="white", outline="black")
    top = height - BAR_H
    draw.rectangle([0, top, width, height], fill=BAR)
    draw.rectangle([0, top, width, top + 2], fill=AMBER)
    if key:
        label_w = draw.textlength(key, font=KEY)
        box_w, box_h = max(label_w + 24, BAR_H - 20), BAR_H - 22
        right = width - PAD
        draw.rounded_rectangle([right - box_w, top + 12, right, top + 12 + box_h], radius=7, fill=(58, 58, 58), outline=AMBER, width=2)
        draw.text((right - box_w / 2, top + 12 + box_h / 2), key, font=KEY, fill="white", anchor="mm")
        caption_right = right - box_w - PAD
    else:
        caption_right = width - PAD
    text = caption
    while draw.textlength(text, font=SANS) > caption_right - PAD and len(text) > 1:
        text = text[:-2] + "…"
    draw.text((PAD * 2, top + 2 + (BAR_H - 2) / 2), text, font=SANS, fill="white", anchor="lm")
    return canvas


def main():
    folder, out = Path(sys.argv[1]), Path(sys.argv[2])
    size, frames, marks = read_recording(folder)
    columns, rows = size["columns"], size["rows"]
    scenes = [at for at, label in marks if not re.match(r"(focus|caption|key|click) ", label)]
    start = (scenes[0] if scenes else frames[0][0]) - 2.0
    end = max(frames[-1][0], marks[-1][0]) if marks else frames[-1][0]
    moved = squeeze([at for at, _ in frames] + [at for at, _ in marks], start)
    length = moved(end)

    # What is on show from each time of the GIF: the screen, the caption, the highlight, the last key and click.
    def state_at(time: float):
        screen = max((index for index, (at, _) in enumerate(frames) if moved(at) <= time and at >= start), default=None)
        if screen is None:
            screen = max((index for index, (at, _) in enumerate(frames) if at <= start), default=0)
        caption, focus, key, click = TITLE, None, None, None
        for at, label in marks:
            if moved(at) > time or at < start:
                continue
            kind, _, rest = label.partition(" ")
            if kind == "caption":
                caption = rest
            elif kind == "focus":
                focus = None if rest == "off" else tuple(int(n) for n in rest.split())
            elif kind == "key":
                key = (rest, moved(at))
            elif kind == "click":
                click = (tuple(int(n) for n in rest.split()), moved(at))
            elif not label.startswith(("focus", "caption", "key", "click")):
                focus = None
        key = key[0] if key and time - key[1] < KEY_SHOWN else None
        since = time - click[1] if click else 0
        click = click[0] if click and since < CLICK_SHOWN else None
        return screen, caption, focus, key, click, round(since, 1) if click else 0

    drawn: dict[int, Image.Image] = {}
    with tempfile.TemporaryDirectory() as work:
        listing, last, count = [], None, 0
        steps = int(length * FPS) + 1
        for step in range(steps):
            state = state_at(step / FPS)
            if state == last:
                listing[-1][1] += 1 / FPS
                continue
            last = state
            screen, caption, focus, key, click, since = state
            if screen not in drawn:
                body, x, y, shown = frames[screen][1]
                drawn.clear()
                drawn[screen] = draw_screen(parse(body, columns, rows), (int(x), int(y)) if shown == "1" else None)
            path = Path(work) / f"{count:05d}.png"
            overlay(drawn[screen], columns, caption, focus, key, click, since).save(path)
            listing.append([path, 1 / FPS])
            count += 1
        listing[-1][1] += 3
        concat = Path(work) / "frames.txt"
        concat.write_text("".join(f"file '{path}'\nduration {seconds:.3f}\n" for path, seconds in listing) + f"file '{listing[-1][0]}'\n")
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
             "-vf", "split[a][b];[a]palettegen=stats_mode=diff:max_colors=192[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
             "-fps_mode", "vfr", "-loop", "0", str(out)],
            check=True,
        )
    print(f"wrote {out} ({count} frames, {length:.0f} s, {out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
