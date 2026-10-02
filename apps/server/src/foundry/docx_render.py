#!/usr/bin/env python3
"""Document Foundry — DOCX mirror.

Generates a .docx from the same sanitized content JSON + style tokens that
drive the Typst/PDF pipeline. Token-driven: the agent never touches layout.

Usage:
    python3 docx_render.py --kind resume|cover|statement \\
        --content content.json --tokens tokens.json --out out.docx
"""
import argparse
import json
import sys

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

HYPERLINK_RT = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
)


def hex_rgb(h):
    h = h.lstrip("#")
    return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def set_run(run, font, size_pt, color_hex=None, bold=False, italic=False, underline=False):
    run.font.name = font
    run.font.size = Pt(size_pt)
    if color_hex:
        run.font.color.rgb = hex_rgb(color_hex)
    run.font.bold = bold
    run.font.italic = italic
    run.font.underline = underline
    # keep the east-asian/complex-script font in sync so Word honors the face
    rPr = run._r.get_or_add_rPr()
    for tag in ("w:rFonts",):
        el = rPr.find(qn(tag))
        if el is None:
            el = OxmlElement(tag)
            rPr.append(el)
        el.set(qn("w:ascii"), font)
        el.set(qn("w:hAnsi"), font)


def add_link(paragraph, url, text, font, size_pt, color_hex):
    run = paragraph.add_run(text)
    set_run(run, font, size_pt, color_hex, underline=True)
    r = run._r
    p = paragraph._p
    idx = p.index(r)
    p.remove(r)
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.append(r)
    r_id = paragraph.part.relate_to(url, HYPERLINK_RT, is_external=True)
    hyperlink.set(qn("r:id"), r_id)
    p.insert(idx, hyperlink)


def para(doc, size_pt=10.5, space_after=6, align=None, font=None, tokens=None):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.space_before = Pt(0)
    if align == "center":
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    elif align == "right":
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    p._tokens_font = font or (tokens["font"] if tokens else "Calibri")
    return p


def bottom_border(p, color_hex, size_pt):
    pPr = p._p.get_or_add_pPr()
    pBdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), str(max(4, int(size_pt * 8))))
    bottom.set(qn("w:space"), "6")
    bottom.set(qn("w:color"), color_hex.lstrip("#"))
    pBdr.append(bottom)
    pPr.append(pBdr)


def rule_for(tokens):
    if tokens["rule"] == "bar":
        return (tokens["accent"], 3.0)
    if tokens["rule"] == "hairline":
        return (tokens["gray"], 0.5)
    return (tokens["accent"], 1.0)


def clear_table_borders(table):
    tblPr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "nil")
        el.set(qn("w:sz"), "0")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "auto")
        borders.append(el)
    tblPr.append(borders)


def headrow(doc, tokens, left_runs, right_text, font_size=10.5):
    """Two-column header row: bold title left, dates right, no borders."""
    table = doc.add_table(rows=1, cols=2)
    table.autofit = False
    table.columns[0].width = Inches(5.6)
    table.columns[1].width = Inches(1.9)
    clear_table_borders(table)
    c0 = table.cell(0, 0).paragraphs[0]
    c1 = table.cell(0, 1).paragraphs[0]
    c1.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    for text, bold, color in left_runs:
        run = c0.add_run(text)
        set_run(run, tokens["font"], font_size, color, bold=bold)
    run = c1.add_run(right_text)
    set_run(run, tokens["font"], font_size - 0.5, tokens["gray"])
    # tighten table spacing
    for cell in table.row_cells(0):
        for par in cell.paragraphs:
            par.paragraph_format.space_after = Pt(1)
            par.paragraph_format.space_before = Pt(0)
    doc.add_paragraph().paragraph_format.space_after = Pt(1)  # spacer


def section_heading(doc, tokens, title):
    p = para(doc, size_pt=11, space_after=4, font=tokens["font"], tokens=tokens)
    run = p.add_run(title.upper())
    set_run(run, tokens["font"], 11, tokens["accent"], bold=True)
    # letterspacing approximation is not supported; keep it clean
    color, size = rule_for(tokens)
    bottom_border(p, color, size)
    return p


def bullet(doc, tokens, runs, size_pt=10.5):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.space_before = Pt(0)
    for text, bold in runs:
        run = p.add_run(text)
        set_run(run, tokens["font"], size_pt, None, bold=bold)


def contact_line(doc, tokens, data, centered):
    p = para(doc, size_pt=9.5, space_after=2, align="center" if centered else None,
             font=tokens["font"], tokens=tokens)
    run = p.add_run(f"{data['email']} · {data['mobile']}")
    set_run(run, tokens["font"], 9.5, tokens["gray"])
    for link in data.get("links", []):
        r = p.add_run(" · ")
        set_run(r, tokens["font"], 9.5, tokens["gray"])
        add_link(p, link["url"], link["label"], tokens["font"], 9.5, tokens["accent"])


def letterhead(doc, tokens, data):
    centered = tokens["header"] == "center"
    name_color = tokens.get("name_color") or "#1A1A1A"
    p = para(doc, size_pt=24, space_after=2, align="center" if centered else None,
             font=tokens["font"], tokens=tokens)
    run = p.add_run(data["full_name"])
    set_run(run, tokens["font"], 24, name_color, bold=True)
    contact_line(doc, tokens, data, centered)
    rule_p = para(doc, size_pt=2, space_after=8, font=tokens["font"], tokens=tokens)
    color, size = rule_for(tokens)
    bottom_border(rule_p, color, size)


def build_resume(doc, tokens, data):
    letterhead(doc, tokens, data)

    if data.get("education"):
        section_heading(doc, tokens, "Education")
        for e in data["education"]:
            headrow(doc, tokens, [(e["institution"], True, None)], e["location"])
            headrow(doc, tokens, [(e["degree"], False, None)], e["dates"])

    if data.get("skills"):
        section_heading(doc, tokens, "Skills Summary")
        if tokens.get("name_color"):  # corporate grid: two-column skills
            table = doc.add_table(rows=(len(data["skills"]) + 1) // 2, cols=2)
            table.autofit = False
            table.columns[0].width = Inches(3.75)
            table.columns[1].width = Inches(3.75)
            clear_table_borders(table)
            for i, s in enumerate(data["skills"]):
                cell = table.cell(i // 2, i % 2).paragraphs[0]
                r1 = cell.add_run(s["category"] + "\n")
                set_run(r1, tokens["font"], 9.5, tokens["accent"], bold=True)
                r2 = cell.add_run(s["items"])
                set_run(r2, tokens["font"], 9.5, None)
            doc.add_paragraph().paragraph_format.space_after = Pt(2)
        else:
            for s in data["skills"]:
                bullet(doc, tokens, [(s["category"] + ": ", True), (s["items"], False)])

    for section, title in (("experience", "Work Experience"),
                           ("projects", "Projects"),
                           ("certificates", "Certificates")):
        entries = data.get(section) or []
        if not entries:
            continue
        section_heading(doc, tokens, title)
        for e in entries:
            left = [(e["title"].upper(), True, None)]
            if e.get("tag"):
                left.append((" | ", True, None))
                # tag as link when a url exists
                headrow(doc, tokens, left, e["dates"])
                # append the tag run/link to the left cell's paragraph
                cell_par = doc.tables[-1].cell(0, 0).paragraphs[0]
                if e.get("tag_url"):
                    add_link(cell_par, e["tag_url"], e["tag"], tokens["font"], 10.5,
                             tokens["accent"])
                else:
                    r = cell_par.add_run(e["tag"])
                    set_run(r, tokens["font"], 10.5, tokens["accent"])
            else:
                headrow(doc, tokens, left, e["dates"])
            for b in e.get("bullets", []):
                bullet(doc, tokens, [(b, False)])
            doc.add_paragraph().paragraph_format.space_after = Pt(4)


def build_cover(doc, tokens, data):
    letterhead(doc, tokens, data)
    d = para(doc, size_pt=11, space_after=10, font=tokens["font"], tokens=tokens)
    r = d.add_run(data["date"])
    set_run(r, tokens["font"], 11, None)

    rec = para(doc, size_pt=11, space_after=10, font=tokens["font"], tokens=tokens)
    if data.get("recipient_name"):
        rr = rec.add_run(data["recipient_name"] + "\n")
        set_run(rr, tokens["font"], 11, None)
    if data.get("recipient_title"):
        rr = rec.add_run(data["recipient_title"] + "\n")
        set_run(rr, tokens["font"], 11, None)
    rc = rec.add_run(data["company"] + "\n")
    set_run(rc, tokens["font"], 11, None, bold=True)
    for a in data.get("address_lines", []):
        ra = rec.add_run(a + "\n")
        set_run(ra, tokens["font"], 11, None)

    s = para(doc, size_pt=11, space_after=6, font=tokens["font"], tokens=tokens)
    rs = s.add_run(data["salutation"])
    set_run(rs, tokens["font"], 11, None)

    for ptext in data["paragraphs"]:
        p = para(doc, size_pt=11, space_after=7, font=tokens["font"], tokens=tokens)
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        rp = p.add_run(ptext)
        set_run(rp, tokens["font"], 11, None)

    c = para(doc, size_pt=11, space_after=2, font=tokens["font"], tokens=tokens)
    rcl = c.add_run(data["closing"])
    set_run(rcl, tokens["font"], 11, None)
    sig = para(doc, size_pt=11, space_after=2, font=tokens["font"], tokens=tokens)
    sig.paragraph_format.space_before = Pt(18)
    rsig = sig.add_run(data["full_name"])
    set_run(rsig, tokens["font"], 11, None, bold=True)


def build_statement(doc, tokens, data):
    centered = tokens["header"] == "center"
    name_color = tokens.get("name_color") or "#1A1A1A"
    p = para(doc, size_pt=24, space_after=2, align="center" if centered else None,
             font=tokens["font"], tokens=tokens)
    run = p.add_run(data["full_name"])
    set_run(run, tokens["font"], 24, name_color, bold=True)
    contact_line(doc, tokens, data, centered)

    t = para(doc, size_pt=15, space_after=4, align="center" if centered else None,
             font=tokens["font"], tokens=tokens)
    rt = t.add_run(data["title"].upper())
    set_run(rt, tokens["font"], 15, None, bold=True)
    color, size = rule_for(tokens)
    bottom_border(t, color, size)

    for ptext in data["paragraphs"]:
        pg = para(doc, size_pt=11, space_after=7, font=tokens["font"], tokens=tokens)
        pg.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        rp = pg.add_run(ptext)
        set_run(rp, tokens["font"], 11, None)

    f = para(doc, size_pt=11, space_after=2, font=tokens["font"], tokens=tokens)
    f.paragraph_format.space_before = Pt(12)
    rf = f.add_run(data["date"] + "\n")
    set_run(rf, tokens["font"], 11, None)
    rn = f.add_run(data["full_name"])
    set_run(rn, tokens["font"], 11, None, bold=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", required=True, choices=["resume", "cover", "statement"])
    ap.add_argument("--content", required=True)
    ap.add_argument("--tokens", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with open(args.content, encoding="utf-8") as f:
        data = json.load(f)
    with open(args.tokens, encoding="utf-8") as f:
        tokens = json.load(f)

    doc = Document()
    section = doc.sections[0]
    section.left_margin = Inches(0.75)
    section.right_margin = Inches(0.75)
    section.top_margin = Inches(0.8)
    section.bottom_margin = Inches(0.8)

    normal = doc.styles["Normal"]
    normal.font.name = tokens["font"]
    normal.font.size = Pt(10.5)

    if tokens.get("page_bg"):
        background = OxmlElement("w:background")
        background.set(qn("w:color"), tokens["page_bg"].lstrip("#"))
        doc.element.insert(0, background)
        settings = doc.settings.element
        disp = OxmlElement("w:displayBackgroundShape")
        settings.append(disp)

    if args.kind == "resume":
        build_resume(doc, tokens, data)
    elif args.kind == "cover":
        build_cover(doc, tokens, data)
    else:
        build_statement(doc, tokens, data)

    doc.save(args.out)
    print(json.dumps({"ok": True, "out": args.out}))


if __name__ == "__main__":
    sys.exit(main())
