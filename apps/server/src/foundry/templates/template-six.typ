// Template Six — "Corporate Grid".
// Locked design. Dark-slate corporate: thick top rule, structured grid,
// hairline dividers between entries.

#let data = json("content.json")

#let ink = rgb("#1F2937")
#let navy = rgb("#1E3A5F")
#let gray = rgb("#6B7280")
#let hairline = rgb("#D1D5DB")

#set page(paper: "a4", margin: (x: 18mm, y: 16mm))
#set text(font: "Liberation Sans", size: 10pt, fill: ink)
#set par(leading: 4pt, justify: true, spacing: 5pt)
#set list(marker: text("▸", size: 8pt, fill: navy), indent: 10pt, body-indent: 7pt, spacing: 4pt)

#rect(width: 100%, height: 4pt, fill: navy, stroke: none)
#v(8pt)

#grid(
  columns: (1fr, auto),
  gutter: 12pt,
  [
    #text(size: 24pt, weight: "bold", fill: navy, data.full_name)
  ],
  align(right)[
    #text(size: 9pt, fill: gray)[
      #data.email \
      #data.mobile \
      #for l in data.links [#text(fill: navy, link(l.url)[#l.label]) \ ]
    ]
  ],
)
#v(8pt)

#let section(title) = {
  v(8pt)
  grid(
    columns: (auto, 1fr),
    gutter: 8pt,
    text(size: 11pt, weight: "bold", tracking: 2pt, fill: navy, upper(title)),
    align(horizon)[#line(length: 100%, stroke: 0.8pt + hairline)],
  )
  v(5pt)
}

#let headrow(left, rightside) = grid(
  columns: (1fr, auto),
  gutter: 8pt,
  [#left],
  align(right)[#text(size: 9.5pt, fill: gray, rightside)],
)

#let taglink(e) = {
  if "tag" in e [
    #text(fill: navy, size: 9pt)[ | #if "tag_url" in e [#link(e.tag_url)[#e.tag]] else [#e.tag]]
  ]
}

#let dated-entry(e) = {
  headrow(
    [#text(weight: "bold", e.title)#taglink(e)],
    [#e.dates],
  )
  for b in e.bullets [
    - #b
  ]
  v(3pt)
  line(length: 100%, stroke: 0.4pt + hairline)
  v(5pt)
}

#section("Education")
#for e in data.education {
  headrow([#text(weight: "bold", e.institution)], [#e.location])
  text(size: 9.5pt, fill: gray, [#e.degree · #e.dates])
  v(3pt)
  line(length: 100%, stroke: 0.4pt + hairline)
  v(5pt)
}

#section("Skills")
#grid(
  columns: (1fr, 1fr),
  gutter: 12pt,
  ..for s in data.skills {
    (
      [
        #text(weight: "bold", fill: navy, size: 9.5pt)[#s.category] \
        #text(size: 9.5pt, s.items)
        #v(4pt)
      ],
    )
  }
)

#if data.experience.len() > 0 {
  section("Work Experience")
  for e in data.experience [#dated-entry(e)]
}
#if data.projects.len() > 0 {
  section("Projects")
  for e in data.projects [#dated-entry(e)]
}
#if data.certificates.len() > 0 {
  section("Certificates")
  for e in data.certificates [#dated-entry(e)]
}
