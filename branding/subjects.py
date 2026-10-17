"""Neutral avatar subjects drawn in code (no people, no stock photos):

    python branding/subjects.py

Writes subject_smiley.png, subject_sunset.png, subject_heart.png (1024x1024)
for make_avatar.py.
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.dirname(os.path.abspath(__file__))
N = 1024
SS = 2


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def vgradient(size, top, bottom):
    img = Image.new('RGB', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp(top, bottom, y / (size - 1)))
    return img


def radial(size, center, inner, outer, radius):
    img = Image.new('RGB', (size, size))
    px = img.load()
    cx, cy = center
    for y in range(size):
        for x in range(size):
            t = min(1.0, math.hypot(x - cx, y - cy) / radius)
            px[x, y] = lerp(inner, outer, t)
    return img


def smiley():
    n = N * SS
    img = vgradient(n, (255, 94, 98), (255, 153, 102)).convert('RGBA')   # coral -> peach
    face_r = int(n * 0.40)
    cx, cy = n // 2, n // 2
    # soft shadow
    sh = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse((cx - face_r, cy - face_r + n * 0.03, cx + face_r, cy + face_r + n * 0.03), fill=(90, 20, 40, 120))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(n * 0.025)))
    # glossy yellow face
    face = radial(2 * face_r, (face_r * 0.75, face_r * 0.6), (255, 236, 120), (247, 168, 22), face_r * 1.35).convert('RGBA')
    mask = Image.new('L', (2 * face_r, 2 * face_r), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, 2 * face_r - 1, 2 * face_r - 1), fill=255)
    img.paste(face, (cx - face_r, cy - face_r), mask)
    d = ImageDraw.Draw(img)
    # eyes
    ew, eh = face_r * 0.17, face_r * 0.30
    for ex in (cx - face_r * 0.36, cx + face_r * 0.36):
        ey = cy - face_r * 0.18
        d.ellipse((ex - ew / 2, ey - eh / 2, ex + ew / 2, ey + eh / 2), fill=(70, 40, 20))
        d.ellipse((ex - ew * 0.18, ey - eh * 0.36, ex + ew * 0.16, ey - eh * 0.06), fill=(255, 255, 255))
    # smile
    w = face_r * 0.95
    box = (cx - w / 2, cy - face_r * 0.15, cx + w / 2, cy + face_r * 0.62)
    d.arc(box, start=20, end=160, fill=(70, 40, 20), width=int(face_r * 0.09))
    # cheeks
    for chx in (cx - face_r * 0.58, cx + face_r * 0.58):
        blush = Image.new('RGBA', (n, n), (0, 0, 0, 0))
        ImageDraw.Draw(blush).ellipse((chx - face_r * 0.15, cy + face_r * 0.12, chx + face_r * 0.15, cy + face_r * 0.30), fill=(255, 110, 110, 110))
        img.alpha_composite(blush.filter(ImageFilter.GaussianBlur(face_r * 0.04)))
    # shine
    shine = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(shine).ellipse((cx - face_r * 0.62, cy - face_r * 0.82, cx - face_r * 0.05, cy - face_r * 0.48), fill=(255, 255, 255, 90))
    img.alpha_composite(shine.filter(ImageFilter.GaussianBlur(face_r * 0.05)))
    return img.convert('RGB').resize((N, N), Image.LANCZOS)


def sunset():
    n = N * SS
    img = vgradient(n, (255, 94, 120), (255, 196, 110)).convert('RGBA')  # pink sky -> warm horizon
    d = ImageDraw.Draw(img)
    sun_r = n * 0.17
    cx, cy = n * 0.5, n * 0.52
    glow = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((cx - sun_r * 1.8, cy - sun_r * 1.8, cx + sun_r * 1.8, cy + sun_r * 1.8), fill=(255, 240, 180, 110))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(n * 0.05)))
    d = ImageDraw.Draw(img)
    d.ellipse((cx - sun_r, cy - sun_r, cx + sun_r, cy + sun_r), fill=(255, 244, 196))
    layers = [
        ((150, 70, 140), 0.56, 0.10, 3.1), ((103, 52, 128), 0.64, 0.08, 5.3), ((62, 36, 98), 0.73, 0.07, 2.2), ((34, 24, 66), 0.83, 0.05, 4.4),
    ]
    for color, base, amp, freq in layers:
        pts = [(0, n)]
        for i in range(0, 101):
            x = n * i / 100
            y = n * base - n * amp * (0.6 * math.sin(i / 100 * math.pi * freq) + 0.4 * math.sin(i / 100 * math.pi * freq * 2.7 + 1.3))
            pts.append((x, y))
        pts.append((n, n))
        d.polygon(pts, fill=color)
    return img.convert('RGB').resize((N, N), Image.LANCZOS)


def heart():
    n = N * SS
    img = vgradient(n, (255, 207, 222), (255, 150, 190)).convert('RGBA')
    cx, cy, s = n / 2, n * 0.52, n * 0.30
    pts = []
    for i in range(400):
        t = i / 400 * 2 * math.pi
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((cx + x * s / 16, cy - y * s / 16))
    sh = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x, y + n * 0.03) for x, y in pts], fill=(140, 20, 60, 120))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(n * 0.025)))
    fill = radial(n, (cx - s * 0.4, cy - s * 0.5), (255, 92, 110), (200, 16, 52), s * 1.6).convert('RGBA')
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    img.paste(fill, (0, 0), mask)
    shine = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(shine).ellipse((cx - s * 0.82, cy - s * 0.78, cx - s * 0.30, cy - s * 0.42), fill=(255, 255, 255, 110))
    img.alpha_composite(shine.filter(ImageFilter.GaussianBlur(s * 0.06)))
    return img.convert('RGB').resize((N, N), Image.LANCZOS)


if __name__ == '__main__':
    for name, fn in (('smiley', smiley), ('sunset', sunset), ('heart', heart)):
        fn().save(os.path.join(OUT, f'subject_{name}.png'))
        print('written', name)
