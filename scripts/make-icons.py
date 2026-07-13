#!/usr/bin/env python3
"""
Generates the full A11y Lens icon set for Tauri.

The mark is the "lens ring" from the app itself — the score dial you see on the
Dashboard — so the icon and the product share one visual idea rather than being
unrelated. An open ring reads clearly at 16px in a Windows taskbar, where a
detailed glyph would turn to mush.
"""
from PIL import Image, ImageDraw
import os

OUT = "src-tauri/icons"
os.makedirs(OUT, exist_ok=True)

BG        = (14, 17, 22, 255)      # #0E1116  app background
RING_TRACK= (154, 167, 180, 60)    # muted track
RING      = (138, 199, 255, 255)   # #8AC7FF  primary (focus-ring blue)
ACCENT    = (123, 232, 176, 255)   # #7BE8B0  pass green
PUPIL     = (233, 238, 245, 255)   # #E9EEF5  text

# Draw large, then downsample — antialiasing for free.
S = 1024


def render(size: int) -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded-square background (macOS/Windows both expect a filled tile).
    pad = int(S * 0.06)
    d.rounded_rectangle(
        [pad, pad, S - pad, S - pad],
        radius=int(S * 0.20),
        fill=BG,
    )

    cx = cy = S / 2
    r = S * 0.30
    w = int(S * 0.085)

    # Full faint track, so the open ring reads as deliberate rather than broken.
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=RING_TRACK, width=w)

    # The "scored" arc — an open ring, exactly like the ScoreRing component.
    box = [cx - r, cy - r, cx + r, cy + r]
    d.arc(box, start=-90, end=200, fill=RING, width=w)

    # A short accent tail: the app's pass-green, hinting at "score improving".
    d.arc(box, start=200, end=250, fill=ACCENT, width=w)

    # Lens pupil.
    pr = S * 0.085
    d.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=PUPIL)

    return img.resize((size, size), Image.LANCZOS)


# --- PNGs Tauri expects -----------------------------------------------------
sizes = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}
for name, px in sizes.items():
    render(px).save(os.path.join(OUT, name), "PNG")

# --- Windows .ico (multi-resolution — this is what the MSI bundler wanted) ---
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
render(256).save(
    os.path.join(OUT, "icon.ico"),
    format="ICO",
    sizes=[(s, s) for s in ico_sizes],
)

# --- macOS .icns ------------------------------------------------------------
try:
    render(1024).save(os.path.join(OUT, "icon.icns"), format="ICNS")
except Exception as e:  # noqa: BLE001
    print(f"  (icns skipped: {e})")

print("Generated:")
for f in sorted(os.listdir(OUT)):
    print(f"  {OUT}/{f}")
