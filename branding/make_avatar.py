"""Bot avatar + transition animation: a photo breaking into an emoji-pack grid.

    python branding/make_avatar.py path/to/photo.jpg [name]

With [name] the files get a suffix (avatar_<name>.png, ...), so variants don't overwrite each other.

Writes next to this script:
  avatar.png          512x512, the photo mid-transition (top-left whole, bottom-right tiles)
  avatar_grid.png     512x512, fully split into tiles
  transition.gif      photo -> tiles -> photo loop (for the bot's description picture)

Not deployed: this is a local helper (needs Pillow).
"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.dirname(os.path.abspath(__file__))
SIZE = 512        # final size
SS = 2            # supersampling for smooth edges
GRID = 8          # tiles per side, like the 8-per-row emoji panel
GIF_SIZE = 360    # the animation is smaller to keep the file light
BG_TOP, BG_BOTTOM = (42, 171, 238), (123, 97, 255)   # Telegram blue -> violet
# BG=dark in the environment: dark gaps like Telegram's night theme.
if os.environ.get('BG') == 'dark':
    BG_TOP, BG_BOTTOM = (23, 33, 43), (36, 47, 61)


def gradient(size):
    img = Image.new('RGB', (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
    return img


def ease(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def pop(t):
    """0..1 with a small overshoot, so tiles 'snap' into place."""
    t = max(0.0, min(1.0, t))
    s = 1.70158
    t -= 1
    return t * t * ((s + 1) * t + s) + 1


def frame(photo, progress, bg):
    """progress per tile = global progress shifted by the tile's diagonal position."""
    n = SIZE * SS
    tile = n // GRID
    canvas = bg.copy()
    shadow_layer = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    tiles_layer = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow_layer)
    for r in range(GRID):
        for c in range(GRID):
            # Diagonal wave: top-left tiles split first.
            delay = (r + c) / (2 * (GRID - 1))
            p = pop((progress - delay * 0.6) / 0.4) if progress > 0 else 0.0
            p = max(0.0, p)
            scale = 1 - 0.16 * p               # gap between tiles
            radius = int(tile * 0.22 * min(1, p))
            lift = int(tile * 0.06 * min(1, p))  # floats up a little
            w = max(1, int(tile * scale))
            cx, cy = c * tile + tile // 2, r * tile + tile // 2 - lift
            x0, y0 = cx - w // 2, cy - w // 2
            piece = photo.crop((c * tile, r * tile, (c + 1) * tile, (r + 1) * tile)).resize((w, w), Image.LANCZOS)
            mask = Image.new('L', (w, w), 0)
            ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, w - 1), radius=radius, fill=255)
            if p > 0.02:
                a = int(110 * min(1, p))
                sd.rounded_rectangle((x0 + 4, y0 + lift + 10, x0 + w + 4, y0 + w + lift + 10), radius=radius, fill=(10, 10, 40, a))
            tiles_layer.paste(piece, (x0, y0), mask)
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(tile * 0.09))
    canvas = canvas.convert('RGBA')
    canvas.alpha_composite(shadow_layer)
    canvas.alpha_composite(tiles_layer)
    return canvas.convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = Image.open(sys.argv[1]).convert('RGB')
    suffix = f'_{sys.argv[2]}' if len(sys.argv) > 2 else ''
    name = lambda base, ext: os.path.join(OUT, f'{base}{suffix}.{ext}')
    side = min(src.size)
    # Center-crop square, a bit higher than center: faces are usually in the upper part.
    left = (src.width - side) // 2
    top = max(0, min(src.height - side, int((src.height - side) * 0.35)))
    photo = src.crop((left, top, left + side, top + side)).resize((SIZE * SS, SIZE * SS), Image.LANCZOS)
    bg = gradient(SIZE * SS)

    frame(photo, 0.36, bg).save(name('avatar', 'png'))
    frame(photo, 1.0, bg).save(name('avatar_grid', 'png'))

    frames, durations = [], []
    steps = 26
    hold = [frame(photo, 0.0, bg)]
    for i in range(steps + 1):
        frames.append(frame(photo, ease(i / steps) * 1.0, bg))
        durations.append(45)
    durations[0] = 700          # hold the photo
    durations[-1] = 1300        # hold the grid
    back = frames[-2:0:-1]
    seq = hold + frames + back
    dur = [700] + durations + [35] * len(back)
    seq = [f.resize((GIF_SIZE, GIF_SIZE), Image.LANCZOS) for f in seq]
    seq[0].save(name('transition', 'gif'), save_all=True, append_images=seq[1:],
                duration=dur, loop=0, optimize=True)
    # How Telegram shows the avatar: a small circle.
    av = Image.open(name('avatar', 'png'))
    mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, SIZE - 1, SIZE - 1), fill=255)
    preview = Image.new('RGB', (SIZE + 220, SIZE), (24, 33, 43))
    preview.paste(av, (0, 0), mask)
    for i, d in enumerate((160, 80, 40)):
        small = av.resize((d, d), Image.LANCZOS)
        m = mask.resize((d, d), Image.LANCZOS)
        preview.paste(small, (SIZE + 30, 30 + sum((160, 80, 40)[:i]) + 20 * i), m)
    preview.save(name('avatar_preview', 'png'))
    print('written to', OUT)


if __name__ == '__main__':
    main()
