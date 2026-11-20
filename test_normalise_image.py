#!/usr/bin/python3
"""Tests for normalise_image.py: two-frame MPO, EXIF-rotated JPEG, PNG with alpha, and a non-image (must fail loudly)."""
import json, os, subprocess, sys, tempfile
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
NORM = os.path.join(HERE, "normalise_image.py")


def norm(src, base):
    p = subprocess.run(["/usr/bin/python3", NORM, src, base], capture_output=True, text=True)
    return p.returncode, (json.loads(p.stdout) if p.returncode == 0 else None), p.stderr.strip()


def main():
    d = tempfile.mkdtemp(prefix="synth-norm-")
    ok = True

    def check(name, cond, detail):
        nonlocal ok
        print(("PASS" if cond else "FAIL"), name, detail)
        ok &= bool(cond)

    # 1. Two-frame MPO (first frame red 64x48, second blue 32x32), saved with a .jpg name like a phone photo.
    mpo = os.path.join(d, "phone.jpg")
    Image.new("RGB", (64, 48), (255, 0, 0)).save(mpo, format="MPO", save_all=True,
                                                   append_images=[Image.new("RGB", (32, 32), (0, 0, 255))])
    with Image.open(mpo) as im:
        check("mpo built", im.format == "MPO" and getattr(im, "n_frames", 1) == 2, f"format={im.format} frames={getattr(im, 'n_frames', 1)}")
    rc, r, err = norm(mpo, os.path.join(d, "out-mpo"))
    if rc == 0:
        with Image.open(r["path"]) as o:
            px = o.convert("RGB").getpixel((5, 5))
            check("mpo -> first frame JPEG", r["mime"] == "image/jpeg" and o.format == "JPEG" and o.size == (64, 48)
                  and getattr(o, "n_frames", 1) == 1 and px[0] > 200 and px[2] < 60, f"{r} pixel={px}")
    else:
        check("mpo -> first frame JPEG", False, err)

    # 2. EXIF orientation 6 (rotate 90 CW on display): stored 80x40 must come out 40x80.
    rot = os.path.join(d, "rot.jpg")
    im = Image.new("RGB", (80, 40), (0, 200, 0))
    ex = im.getexif(); ex[0x0112] = 6
    im.save(rot, format="JPEG", exif=ex)
    rc, r, err = norm(rot, os.path.join(d, "out-rot"))
    if rc == 0:
        with Image.open(r["path"]) as o:
            check("exif-rotated JPEG upright", o.size == (40, 80) and o.getexif().get(0x0112) in (None, 1), f"{r}")
    else:
        check("exif-rotated JPEG upright", False, err)

    # 3. PNG with alpha stays PNG with alpha.
    png = os.path.join(d, "alpha.png")
    Image.new("RGBA", (50, 30), (10, 20, 30, 100)).save(png)
    rc, r, err = norm(png, os.path.join(d, "out-png"))
    if rc == 0:
        with Image.open(r["path"]) as o:
            check("alpha PNG kept as PNG", r["mime"] == "image/png" and o.mode == "RGBA" and o.getpixel((1, 1))[3] == 100, f"{r}")
    else:
        check("alpha PNG kept as PNG", False, err)

    # 4. Not an image: exit 2 with a clear message, no output file.
    bad = os.path.join(d, "bad.jpg")
    open(bad, "wb").write(b"this is not an image at all, just text")
    rc, r, err = norm(bad, os.path.join(d, "out-bad"))
    check("non-image fails loudly", rc == 2 and "not an image format" in err and not any(f.startswith("out-bad") for f in os.listdir(d)), f"rc={rc} err={err!r}")

    print("ALL PASS" if ok else "SOME FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
