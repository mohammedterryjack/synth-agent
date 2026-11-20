#!/usr/bin/python3
"""Normalise one input image for Synth (mirrors GlaDOS's _normalize_image_bytes in echo-hermes-bridge/bridge.py).

usage: normalise_image.py <src> <out_base>   (out_base without extension)
Opens with Pillow (MPO phone photos, WebP, GIF, BMP, TIFF, EXIF-rotated JPEGs), applies the EXIF orientation, keeps only
the first frame, re-encodes PNG if it has alpha, else JPEG quality 95. EXIF (incl. GPS) is not copied. Writes
<out_base>.png or <out_base>.jpg and prints one JSON line {path, mime, format, width, height, bytes}. Any failure: a
clear message on stderr and exit 2. No fallbacks.
"""
import io, json, os, sys
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_SOURCE = 40 * 1024 * 1024
QUALITY = 95


def die(msg):
    sys.stderr.write(msg + "\n")
    sys.exit(2)


def main():
    if len(sys.argv) != 3:
        die("usage: normalise_image.py <src> <out_base>")
    src, base = sys.argv[1], sys.argv[2]
    try:
        data = open(src, "rb").read()
    except OSError as e:
        die(f"{src} could not be read: {e.strerror}")
    if len(data) < 16:
        die(f"{src} is empty or not an image")
    if len(data) > MAX_SOURCE:
        die(f"{src} is larger than {MAX_SOURCE // (1024 * 1024)} MiB")
    try:
        with Image.open(io.BytesIO(data)) as im:
            fmt = im.format or "unknown"
            im.seek(0)
            im.load()
            img = ImageOps.exif_transpose(im)
    except UnidentifiedImageError:
        die(f"{src} is not an image format Pillow can open; send a JPEG, PNG, WebP or similar")
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as e:
        die(f"{src} could not be decoded: {e}")
    alpha = img.mode in ("RGBA", "LA", "PA", "RGBa", "La") or (img.mode == "P" and "transparency" in img.info)
    out = io.BytesIO()
    if alpha:
        img.convert("RGBA").save(out, format="PNG", optimize=True); mime, ext = "image/png", ".png"
    else:
        img.convert("RGB").save(out, format="JPEG", quality=QUALITY); mime, ext = "image/jpeg", ".jpg"
    dst = base + ext
    tmp = dst + ".part"
    with open(tmp, "wb") as f:
        f.write(out.getvalue())
    os.replace(tmp, dst)
    print(json.dumps({"path": dst, "mime": mime, "format": fmt, "width": img.width, "height": img.height, "bytes": len(out.getvalue())}))


if __name__ == "__main__":
    main()
