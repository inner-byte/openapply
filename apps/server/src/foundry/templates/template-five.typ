// Template Five — "Minimal".
// Locked design. No background, no frame; hairline rules, quiet typography.

#let data = json("content.json")

#let ink = rgb("#1A1A1A")
#let blue = rgb("#1D4ED8")
#let gray = rgb("#6B7280")
#let hairline = rgb("#D1D5DB")

#set page(paper: "a4", margin: (x: 22mm, y: 18mm))
#set text(font: "Liberation Sans", size: 9.5pt, fill: ink)
#set par(leading: 4pt, justify: true, spacing: 5pt)
#set list(marker: text("·", size: 10pt, baseline: -1pt), indent: 8pt, body-indent: 6pt, spacing: 3pt)

#text(size: 22pt, weight: "bold", data.full_name)
#v(2pt)
#text(size: 9pt, fill: gray)[
  #data.email · #data.mobile
  #for l in data.links [ · #text(fill: blue, link(l.url)[#l.label])]
]
#v(8pt)
#line(length: 100%, stroke: 0.5pt + hairline)

#let section(title) = {
  v(10pt)
  text(size: 10pt, weight: "bold", tracking: 2pt, fill: gray, upper(title))
  v(3pt)
  line(length: 100%, stroke: 0.5pt + hairline)
  v(5pt)
}

#let headrow(left, rightside) = grid(
  columns: (1fr, auto),
  gutter: 8pt,
  [#left],
  align(right)[#text(fill: gray, rightside)],
)

#let taglink(e) = {
  if "tag" in e [
    #text(fill: blue, size: 9pt)[ · #if "tag_url" in e [#link(e.tag_url)[#e.tag]] else [#e.tag]]
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
  v(5pt)
}

#section("Education")
#for e in data.education {
  headrow([#text(weight: "bold", e.institution) — #e.degree], [#e.dates])
  v(1pt)
  text(size: 9pt, fill: gray, e.location)
  v(4pt)
}

#section("Skills")
#text(size: 9.5pt)[
  #for s in data.skills [
    #text(weight: "bold")[#s.category:] #s.items \
  ]
]

#if data.experience.len() > 0 {
  section("Experience")
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
