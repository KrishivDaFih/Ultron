from PIL import Image, ImageDraw, ImageFilter
import math, os

OUT = os.path.dirname(os.path.abspath(__file__))

VOID   = (7, 7, 10)
SCREEN = (11, 11, 16)
PLATE  = (26, 26, 32)
PEDGE  = (46, 46, 56)
RED    = (224, 31, 45)
RHOT   = (255, 68, 56)
RDIM   = (125, 22, 32)
STEEL  = (110, 112, 120)


def poly_rot(cx, cy, pts, deg):
    a = math.radians(deg)
    return [(cx + (x - cx) * math.cos(a) - (y - cy) * math.sin(a),
             cy + (x - cx) * math.sin(a) + (y - cy) * math.cos(a)) for x, y in pts]


def hexagon(cx, cy, r, rot=0):
    return [(cx + r * math.cos(math.radians(60 * i + rot)),
             cy + r * math.sin(math.radians(60 * i + rot))) for i in range(6)]


def draw_core(size, bg=VOID, margin=0.06):
    """Render the Sentinel Core sigil at `size` px square."""
    S = size * 4                      # supersample
    img = Image.new("RGB", (S, S), bg)
    d = ImageDraw.Draw(img)
    c = S / 2
    R = (S / 2) * (1 - margin)

    # glow bed
    glow = Image.new("RGB", (S, S), bg)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([c - R * .42, c - R * .42, c + R * .42, c + R * .42], fill=(70, 10, 15))
    glow = glow.filter(ImageFilter.GaussianBlur(S / 22))
    img = Image.blend(img, glow, 0.85)
    d = ImageDraw.Draw(img)

    lw = max(2, int(S / 128))

    # outer segmented ring
    for i in range(36):
        a0 = i * 10
        if i % 3 == 0:
            d.arc([c - R, c - R, c + R, c + R], a0, a0 + 5.5, fill=RDIM, width=lw)

    # hex lattice
    d.polygon(hexagon(c, c, R * .84, 0), outline=(51, 51, 62), width=lw)
    d.polygon(hexagon(c, c, R * .72, 30), outline=RDIM, width=lw)

    # inner screen disc
    r2 = R * .70
    d.ellipse([c - r2, c - r2, c + r2, c + r2], fill=SCREEN, outline=(35, 35, 44), width=lw)

    # iris plates (8) — partially open
    inner, outer, hw_in, hw_out = R * .30, R * .62, R * .13, R * .30
    base = [(c - hw_in, c - inner), (c + hw_in, c - inner),
            (c + hw_out, c - outer), (c - hw_out, c - outer)]
    for i in range(8):
        d.polygon(poly_rot(c, c, base, 45 * i), fill=PLATE, outline=PEDGE, width=max(1, lw // 2))

    # aperture
    ra = R * .31
    d.ellipse([c - ra, c - ra, c + ra, c + ra], fill=(5, 5, 8), outline=(42, 42, 52), width=lw)

    # the eye — hard vertical lens
    eh, ew = R * .28, R * .105
    lens = Image.new("RGB", (S, S), (0, 0, 0))
    ld = ImageDraw.Draw(lens)
    ld.polygon([(c, c - eh), (c + ew, c), (c, c + eh), (c - ew, c)], fill=RED)
    lens = lens.filter(ImageFilter.GaussianBlur(S / 90))
    img = Image.blend(img, Image.blend(img, lens, 1.0).point(lambda v: v), 0.0)  # keep base
    # composite the lens additively
    px_i, px_l = img.load(), lens.load()
    for y in range(int(c - eh - S / 40), int(c + eh + S / 40)):
        for x in range(int(c - ew - S / 40), int(c + ew + S / 40)):
            if 0 <= x < S and 0 <= y < S:
                r, g, b = px_i[x, y]
                lr, lg, lb = px_l[x, y]
                px_i[x, y] = (min(255, r + lr), min(255, g + lg), min(255, b + lb))
    d = ImageDraw.Draw(img)
    d.polygon([(c, c - eh), (c + ew, c), (c, c + eh), (c - ew, c)], fill=RHOT)

    return img.resize((size, size), Image.LANCZOS)


# ---- app icon (multi-resolution .ico) ----
master = draw_core(1024)
sizes = [256, 128, 64, 48, 32, 24, 16]
icons = [master.resize((s, s), Image.LANCZOS) for s in sizes]
icons[0].save(os.path.join(OUT, "icon.ico"), format="ICO",
              sizes=[(s, s) for s in sizes])
master.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon.png"))

# ---- NSIS sidebar 164x314 ----
side = Image.new("RGB", (164, 314), VOID)
sd = ImageDraw.Draw(side)
for y in range(314):                     # vertical gunmetal gradient
    t = y / 313
    sd.line([(0, y), (164, y)], fill=(int(7 + 9 * t), int(7 + 9 * t), int(10 + 12 * t)))
core = draw_core(150, bg=(11, 11, 15), margin=0.05)
side.paste(core, (7, 58))
sd.line([(0, 0), (163, 0)], fill=RDIM)
sd.line([(0, 313), (163, 313)], fill=RDIM)
sd.line([(20, 232), (144, 232)], fill=RDIM)
side.save(os.path.join(OUT, "sidebar.bmp"), format="BMP")

# ---- NSIS header 150x57 ----
head = Image.new("RGB", (150, 57), (12, 12, 17))
hd = ImageDraw.Draw(head)
hd.rectangle([0, 0, 149, 56], outline=(30, 30, 38))
hd.line([(0, 56), (149, 56)], fill=RDIM)
head.paste(draw_core(44, bg=(12, 12, 17), margin=0.02), (101, 6))
head.save(os.path.join(OUT, "header.bmp"), format="BMP")

print("assets written:", os.listdir(OUT))
