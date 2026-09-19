#!/usr/bin/env node
/**
 * Renders the social card.
 *
 * Committed as a script rather than a one-off image so the card can be rebuilt
 * when the palette or the wordmark changes — the brand colours here must be the
 * ones in styles.css, and an image nobody can regenerate drifts from them
 * silently. Uses the real Fredoka file in scripts/assets so the mark on the
 * card is the same mark as on the page, not a lookalike.
 *
 * Output: apps/web/public/og.png at 1200x630, the size Open Graph, Twitter and
 * WhatsApp all accept.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const py = `
from PIL import Image, ImageDraw, ImageFont

GROUND, INK, RIGHT, PLACE, CHALK, DIM = '#6e5c62', '#191516', '#1f7468', '#e8c88e', '#fafaff', '#d6cbcf'
W, H = 1200, 630
img = Image.new('RGB', (W, H), GROUND)
d = ImageDraw.Draw(img)

def f(size, weight='SemiBold'):
    ft = ImageFont.truetype(r'${join(root, 'scripts/assets/Fredoka.ttf')}', size)
    try: ft.set_variation_by_name(weight)
    except Exception: pass
    return ft

# A field of faint boards behind everything — the same "watch the room play"
# image the landing uses, so the card and the page are recognisably one thing.
import random
random.seed(7)
for by in range(-1, 7):
    for bx in range(-1, 14):
        ox, oy = bx*96 + 18, by*104 + 12
        rows = random.randint(0, 4)
        for r in range(6):
            for c in range(5):
                x, y = ox + c*15, oy + r*15
                if r < rows:
                    v = random.random() + r*0.1
                    col = RIGHT if v > .82 else PLACE if v > .58 else INK
                    a = 70
                else:
                    col, a = INK, 22
                over = Image.new('RGB', (12, 12), col)
                img.paste(Image.blend(img.crop((x, y, x+12, y+12)), over, a/255), (x, y))

# Scrim so the type reads over the field.
scrim = Image.new('RGB', (W, H), INK)
img = Image.blend(img, scrim, 0.42)
d = ImageDraw.Draw(img)

# The wordmark IS a Termo row: T3RMO is exactly five characters.
TILE, GAP, X0, Y0 = 104, 10, 80, 150
for i, ch in enumerate('T3RMO'):
    x = X0 + i*(TILE+GAP)
    fill = RIGHT if ch == '3' else '#221d1f'
    d.rounded_rectangle([x, Y0, x+TILE, Y0+TILE], radius=16, fill=fill)
    ft = f(58)
    bb = d.textbbox((0, 0), ch, font=ft)
    d.text((x + (TILE-(bb[2]-bb[0]))/2 - bb[0], Y0 + (TILE-(bb[3]-bb[1]))/2 - bb[1]), ch, font=ft, fill=CHALK)

d.text((X0, Y0+TILE+44), 'Termo competitivo', font=f(72), fill=CHALK)
d.text((X0, Y0+TILE+128), 'em tempo real', font=f(72), fill=RIGHT)
d.text((X0, Y0+TILE+232),
       'Milhares de pessoas na mesma sala, na mesma palavra, no mesmo segundo.',
       font=f(27, 'Medium'), fill=DIM)
d.text((X0, Y0+TILE+274),
       'Quem fecha em menos tentativas fica na frente.  ·  t3rmo.com',
       font=f(27, 'Medium'), fill=DIM)

img.save(r'${join(root, 'apps/web/public/og.png')}', optimize=True)
print('og.png', img.size)
`;
const r = spawnSync('python3', ['-c', py], { stdio: 'inherit' });
process.exit(r.status ?? 1);
