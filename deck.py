#!/usr/bin/env python3
"""Synth make_deck engine: an editable 16:9 .pptx from a fixed set of layouts with power-pptx (MIT,
github.com/CodeHalwell/power-pptx). Text is sized with TextFrame.fit_text (measured with the real font file),
then every slide is checked with slide.lint() (TextOverflow, OffSlide, ShapeCollision, LowContrast, MinFontSize...).
Lint findings are returned as warnings; nothing is blocked or auto-changed. Fails loudly on bad input.

usage: deck.py spec.json out.pptx  -> prints one JSON line {"slides": n, "lint": [...]}
spec: {"title", "colours": {bg, fg, accent, muted}, "font": {"family", "regular", "bold"}, "slides": [...]}
(image fields are absolute paths already resolved and normalised by synth-agent)."""
import json
import sys

from PIL import Image
from power_pptx import Presentation
from power_pptx.dml.color import RGBColor
from power_pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from power_pptx.util import Emu, Inches, Pt

W, H = Inches(13.333), Inches(7.5)
M = Inches(0.6)


def rgb(h):
    return RGBColor.from_hex(h)


def main(spec_path, out_path):
    spec = json.load(open(spec_path))
    col, font = spec['colours'], spec['font']
    prs = Presentation()
    prs.slide_width, prs.slide_height = W, H
    blank = prs.slide_layouts[6]
    prs.core_properties.title = spec['title']

    def box(slide, x, y, w, h, text, size, bold=False, colour='fg', align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, lines=None, min_size=12):
        tb = slide.shapes.add_textbox(x, y, w, h)
        tf = tb.text_frame
        tf.word_wrap = True
        tf.vertical_anchor = anchor
        for m in ('margin_left', 'margin_right', 'margin_top', 'margin_bottom'):
            setattr(tf, m, Inches(0.05))
        paras = lines if lines is not None else [text]
        for i, t in enumerate(paras):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.alignment = align
            r = p.add_run()
            r.text = (u'\u2022  ' + t) if lines is not None else t
            r.font.name = font['family']
            r.font.bold = bold
            r.font.color.rgb = rgb(col[colour])
            if lines is not None:
                p.space_after = Pt(10)
        tf.fit_text(font_family=font['family'], max_size=size, bold=bold, font_file=font['bold' if bold else 'regular'], min_size=min_size)
        return tb

    def picture(slide, path, x, y, w, h):
        iw, ih = Image.open(path).size
        pic = slide.shapes.add_picture(path, x, y, w, h)
        target, src = w / h, iw / ih
        if src > target:  # crop the sides
            c = (1 - target / src) / 2
            pic.crop_left = pic.crop_right = c
        elif src < target:  # crop top/bottom
            c = (1 - src / target) / 2
            pic.crop_top = pic.crop_bottom = c
        return pic

    for n, s in enumerate(spec['slides'], 1):
        slide = prs.slides.add_slide(blank)
        bg = slide.background.fill
        bg.solid()
        bg.fore_color.rgb = rgb(col['bg'])
        L = s['layout']
        cw = W - 2 * M
        if L in ('title', 'section'):
            if L == 'section':
                bar = slide.shapes.add_shape(1, M, Inches(3.1), Inches(1.2), Inches(0.12))
                bar.fill.solid(); bar.fill.fore_color.rgb = rgb(col['accent']); bar.line.fill.background()
            box(slide, M, Inches(1.6) if L == 'title' else Inches(3.35), cw, Inches(2.4) if L == 'title' else Inches(1.6), s['title'], 60 if L == 'title' else 48, True,
                align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.BOTTOM if L == 'title' else MSO_ANCHOR.TOP, min_size=24)
            if s.get('subtitle'):
                box(slide, M, Inches(4.2) if L == 'title' else Inches(5.0), cw, Inches(1.4), s['subtitle'], 28, colour='muted', min_size=16)
        elif L == 'bullets':
            box(slide, M, Inches(0.5), cw, Inches(1.2), s['title'], 40, True, anchor=MSO_ANCHOR.BOTTOM, min_size=24)
            box(slide, M, Inches(2.0), cw, Inches(4.9), None, 28, lines=s['bullets'], min_size=18)
        elif L in ('image_left', 'image_right'):
            iw = Inches(6.4)
            ix = M if L == 'image_left' else W - M - iw
            tx = M + iw + Inches(0.5) if L == 'image_left' else M
            tw = cw - iw - Inches(0.5)
            picture(slide, s['image'], ix, Inches(0.6), iw, Inches(6.3))
            box(slide, tx, Inches(0.6), tw, Inches(1.6), s['title'], 36, True, anchor=MSO_ANCHOR.BOTTOM, min_size=20)
            if s.get('bullets'):
                box(slide, tx, Inches(2.5), tw, Inches(4.4), None, 24, lines=s['bullets'], min_size=16)
            elif s.get('caption'):
                box(slide, tx, Inches(2.5), tw, Inches(4.4), s['caption'], 24, colour='muted', min_size=16)
        elif L == 'full_image':
            picture(slide, s['image'], 0, 0, W, H)
            if s.get('caption'):
                band = slide.shapes.add_shape(1, 0, H - Inches(1.4), W, Inches(1.4))
                band.fill.solid(); band.fill.fore_color.rgb = rgb(col['bg']); band.line.fill.background()
                band.fill.transparency = 0.2 if hasattr(band.fill, 'transparency') else None
                box(slide, M, H - Inches(1.25), cw, Inches(1.1), s['caption'], 28, anchor=MSO_ANCHOR.MIDDLE, min_size=16)
        elif L == 'quote':
            box(slide, Inches(1.2), Inches(1.2), W - Inches(2.4), Inches(4.0), u'\u201c' + s['quote'] + u'\u201d', 44, True, anchor=MSO_ANCHOR.MIDDLE, min_size=20)
            if s.get('by'):
                box(slide, Inches(1.2), Inches(5.4), W - Inches(2.4), Inches(0.9), u'\u2014 ' + s['by'], 24, colour='accent', min_size=16)
        elif L == 'big_number':
            box(slide, M, Inches(1.0), cw, Inches(3.0), s['number'], 160, True, colour='accent', align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.BOTTOM, min_size=48)
            box(slide, M, Inches(4.2), cw, Inches(1.0), s['label'], 36, True, align=PP_ALIGN.CENTER, min_size=20)
            if s.get('caption'):
                box(slide, M, Inches(5.3), cw, Inches(1.4), s['caption'], 24, colour='muted', align=PP_ALIGN.CENTER, min_size=16)
        else:
            raise SystemExit(f'unknown layout {L!r} on slide {n}')
        if s.get('notes'):
            slide.notes_slide.notes_text_frame.text = s['notes']

    lint = []
    for n, slide in enumerate(prs.slides, 1):
        rep = slide.lint(min_severity='warning')
        for i in rep.to_dict()['issues']:
            lint.append({'slide': n, **i})
    prs.save(out_path)
    print(json.dumps({'slides': len(prs.slides), 'lint': lint}))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: deck.py spec.json out.pptx')
    main(sys.argv[1], sys.argv[2])
