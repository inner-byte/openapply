// Template Four — "Executive".
// Locked design. Generous whitespace, centered serif name, restrained rules.

#let data = json("content.json")

#let ink = rgb("#1A1A1A")
#let blue = rgb("#1D4ED8")
#let gray = rgb("#6B7280")

#set page(paper: "a4", margin: (x: 24mm, y: 20mm))
#set text(font: "Liberation Serif", size: 10.5pt, fill: ink)
#set par(leading: 5pt, justify: true, spacing: 6pt)
#set list(marker: text("○", size: 6.5pt, baseline: 1pt), indent: 12pt, body-indent: 8pt, spacing: 5pt)

#align(center)[
  #text(size: 28pt, weight: "bold", data.full_name)
  #v(4pt)
  #text(size: 10pt, fill: gray)[
    #data.email · #data.mobile
    #for l in data.links [ · #text(fill: blue, link(l.url)[#l.label])]
  ]
]
#v(10pt)

#let section(title) = {
  v(10pt)
  align(center)[
    #line(length: 55%, stroke: 0.6pt + gray)
    #v(3pt)
    #text(size: 11pt, weight: "bold", tracking: 3pt, upper(title))
    #v(3pt)
    #line(length: 55%, stroke: 0.6pt + gray)
  ]
  v(6pt)
}

#let headrow(left, rightside) = grid(
  columns: (1fr, auto),
  gutter: 8pt,
  [#left],
  align(right)[#rightside],
)

#let taglink(e) = {
  if "tag" in e [
    #text(fill: blue, size: 9.5pt)[ | #if "tag_url" in e [#link(e.tag_url)[#e.tag]] else [#e.tag]]
  ]
}

#let dated-entry(e) = {
  headrow(
    [#text(weight: "bold", upper(e.title))#taglink(e)],
    [#text(size: 10pt, e.dates)],
  )
  for b in e.bullets [
    - #b
  ]
  v(7pt)
}

#section("Education")
#for e in data.education {
  headrow([#text(weight: "bold", e.institution)], [#e.location])
  headrow([#e.degree], [#e.dates])
  v(4pt)
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
