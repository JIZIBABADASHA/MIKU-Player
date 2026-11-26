#!/usr/bin/env python3
"""Before / after: what changed on screen between two versions, so nothing changes that was not meant to.

    node sweep.js --root <old wwwroot> --out A  --shots png [--scen ...] [--sizes ...] [--dpr 2]
    node sweep.js --root <old wwwroot> --out A2 --shots png  (the same again: what moves by itself)
    node sweep.js --root <new wwwroot> --out B  --shots png
    python3 diff.py A A2 B OUT

The two runs of the old version tell what differs from one run to the next on its own (the play position, a clock, a
late picture): those pixels, and 6px around them, are left out. Every other pixel that differs between the old and the
new version by more than a little (any channel by more than 10) counts. Changed pixels are gathered into boxes (8px
cells, touching cells merged). OUT/summary.txt lists every screen with a change and its boxes (in CSS px at --dpr 1,
in device px otherwise); OUT/sheet-<n>.png puts each box old | new side by side, enlarged, for a person to look at.
Screens that did not change are counted, not listed.
"""
import os, sys
from PIL import Image, ImageChops, ImageFilter, ImageDraw

TOL, CELL, PAD = 10, 8, 6


def mask_of(a, b):
    """Pixels where two pictures differ by more than TOL in any channel (L image, 255 = differs)."""
    d = ImageChops.difference(a.convert('RGB'), b.convert('RGB'))
    r, g, bl = d.split()
    m = ImageChops.lighter(ImageChops.lighter(r, g), bl)
    return m.point(lambda v: 255 if v > TOL else 0)


def boxes(mask):
    w, h = mask.size
    cw, ch = (w + CELL - 1) // CELL, (h + CELL - 1) // CELL
    small = mask.resize((cw, ch), Image.BOX).point(lambda v: 255 if v > 0 else 0)
    px = small.load()
    seen, out = set(), []
    for y in range(ch):
        for x in range(cw):
            if px[x, y] and (x, y) not in seen:
                st, x0, y0, x1, y1 = [(x, y)], x, y, x, y
                seen.add((x, y))
                while st:
                    cx, cy = st.pop()
                    x0, y0, x1, y1 = min(x0, cx), min(y0, cy), max(x1, cx), max(y1, cy)
                    for nx in range(cx - 1, cx + 2):
                        for ny in range(cy - 1, cy + 2):
                            if 0 <= nx < cw and 0 <= ny < ch and px[nx, ny] and (nx, ny) not in seen:
                                seen.add((nx, ny)); st.append((nx, ny))
                out.append((x0 * CELL, y0 * CELL, min(w, (x1 + 1) * CELL), min(h, (y1 + 1) * CELL)))
    return out


def main(a_dir, a2_dir, b_dir, out):
    os.makedirs(out, exist_ok=True)
    names = sorted(f for f in os.listdir(os.path.join(a_dir, 'shots')) if f.endswith('.png'))
    lines, crops, same, missing = [], [], 0, []
    for n in names:
        pa, pa2, pb = (os.path.join(d, 'shots', n) for d in (a_dir, a2_dir, b_dir))
        if not (os.path.exists(pa2) and os.path.exists(pb)):
            missing.append(n); continue
        A, A2, B = Image.open(pa), Image.open(pa2), Image.open(pb)
        if A.size != B.size:
            lines.append(f'{n}: size {A.size} -> {B.size}'); continue
        noise = mask_of(A, A2).filter(ImageFilter.MaxFilter(2 * PAD + 1))
        ch = ImageChops.subtract(mask_of(A, B), noise)
        bx = boxes(ch) if ch.getbbox() else []
        if not bx:
            same += 1; continue
        lines.append(f'{n[:-4]}: ' + '; '.join(f'{x0},{y0} {x1 - x0}x{y1 - y0}' for x0, y0, x1, y1 in bx))
        for b in bx:
            crops.append((n[:-4], b, A, B))
    # the sheets: old | new for each box, with a little of what is around it
    rows, sheet_n = [], 0
    def flush():
        nonlocal rows, sheet_n
        if not rows: return
        W = max(r.width for r in rows); H = sum(r.height for r in rows)
        s = Image.new('RGB', (W, H), 'white'); y = 0
        for r in rows: s.paste(r, (0, y)); y += r.height
        sheet_n += 1; s.save(os.path.join(out, f'sheet-{sheet_n}.png')); rows = []
    for name, (x0, y0, x1, y1), A, B in crops[:400]:
        m = 24
        box = (max(0, x0 - m), max(0, y0 - m), min(A.width, x1 + m), min(A.height, y1 + m))
        ca, cb = A.crop(box).convert('RGB'), B.crop(box).convert('RGB')
        k = max(1, min(4, 360 // max(ca.width, ca.height, 1)))
        ca, cb = ca.resize((ca.width * k, ca.height * k), Image.NEAREST), cb.resize((cb.width * k, cb.height * k), Image.NEAREST)
        r = Image.new('RGB', (ca.width * 2 + 30, ca.height + 22), 'white'); d = ImageDraw.Draw(r)
        d.text((4, 4), f'{name}  {x0},{y0} {x1 - x0}x{y1 - y0}   old | new', fill='black')
        r.paste(ca, (0, 22)); r.paste(cb, (ca.width + 30, 22)); rows.append(r)
        if sum(x.height for x in rows) > 2400: flush()
    flush()
    head = f'{len(names)} screens: {same} unchanged, {len(lines)} changed' + (f', {len(missing)} missing in a run' if missing else '')
    open(os.path.join(out, 'summary.txt'), 'w').write(head + '\n\n' + '\n'.join(lines) + '\n')
    print(head)
    for l in lines[:40]: print(l)


if __name__ == '__main__':
    if len(sys.argv) != 5: sys.exit(__doc__)
    main(*sys.argv[1:])
