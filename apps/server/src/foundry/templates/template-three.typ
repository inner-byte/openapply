// Template Three — "Compact".
// Locked design. Dense single-pager: small type, tight spacing, more per page.

#let data = json("content.json")

#let ink = rgb("#1A1A1A")
#let blue = rgb("#1D4ED8")

#set page(paper: "a4", margin: (x: 13mm, y: 12mm))
#set text(font: "Liberation Sans", size: 8.5pt, fill: ink)
#set par(leading: 2.5pt, justify: true, spacing: 3pt)
#set list(marker: text("–", size: 8pt), indent: 8pt, body-indent: 5pt, spacing: 2pt)

#grid(
  columns: (1fr, auto),
  gutter: 8pt,
  [#text(size: 20pt, weight: "bold", data.full_name)],
  align(right)[
    #text(size: 8.5pt)[#data.email · #data.mobile] \
    #for l in data.links [#text(size: 8.5pt, fill: blue, link(l.url)[#l.label]) \ ]
  ],
)
#v(4pt)

#let section(title) = {
  v(6pt)
  text(size: 10pt, weight: "bold", tracking: 1.5pt, upper(title))
  v(1pt)
  line(length: 100%, stroke: 0.6pt)
  v(3pt)
}

#let headrow(left, rightside) = grid(
  columns: (1fr, auto),
  gutter: 8pt,
  [#left],
  align(right)[#rightside],
)

#let taglink(e) = {
  if "tag" in e [
    #text(fill: blue, size: 8pt)[ | #if "tag_url" in e [#link(e.tag_url)[#e.tag]] else [#e.tag]]
  ]
}

#let dated-entry(e) = {
  headrow(
    [#text(weight: "bold", upper(e.title))#taglink(e)],
    [#text(size: 8.5pt, e.dates)],
  )
  for b in e.bullets [
    - #b
  ]
  v(3pt)
}

#section("Education")
#for e in data.education {
  headrow([#text(weight: "bold", e.institution)], [#e.location])
  headrow([#e.degree], [#e.dates])
  v(2pt)
}

#section("Skills")
#for s in data.skills [
  - #text(weight: "bold")[#s.category:] #s.items
]

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
