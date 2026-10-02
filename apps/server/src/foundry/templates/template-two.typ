// Template Two — "Modern Accent".
// Locked design. White page, solid-blue accent bar, sans typography.

#let data = json("content.json")

#let ink = rgb("#111827")
#let blue = rgb("#1D4ED8")
#let gray = rgb("#6B7280")

#set page(paper: "a4", margin: (x: 18mm, y: 16mm))
#set text(font: "Liberation Sans", size: 10pt, fill: ink)
#set par(leading: 4pt, justify: true, spacing: 5pt)
#set list(marker: text("•", size: 8pt, fill: blue), indent: 10pt, body-indent: 7pt, spacing: 4pt)

#text(size: 26pt, weight: "bold", data.full_name)
#v(2pt)
#text(size: 9.5pt, fill: gray)[
  #data.email · #data.mobile
  #for l in data.links [ · #text(fill: blue, link(l.url)[#l.label])]
]
#v(6pt)
#rect(width: 100%, height: 3pt, fill: blue, stroke: none)
#v(6pt)

#let section(title) = {
  v(8pt)
  text(size: 12pt, weight: "bold", fill: blue, tracking: 1pt, upper(title))
  v(2pt)
  line(length: 100%, stroke: 1pt + blue)
  v(5pt)
}

#let headrow(left, rightside) = grid(
  columns: (1fr, auto),
  gutter: 8pt,
  [#left],
  align(right)[#rightside],
)

#let taglink(e) = {
  if "tag" in e [
    #text(fill: blue, size: 9pt)[ | #if "tag_url" in e [#link(e.tag_url)[#e.tag]] else [#e.tag]]
  ]
}

#let dated-entry(e) = {
  headrow(
    [#text(weight: "bold", upper(e.title))#taglink(e)],
    [#text(size: 9.5pt, fill: gray, e.dates)],
  )
  for b in e.bullets [
    - #b
  ]
  v(5pt)
}

#section("Education")
#for e in data.education {
  headrow([#text(weight: "bold", e.institution)], [#text(fill: gray, e.location)])
  headrow([#e.degree], [#text(size: 9.5pt, fill: gray, e.dates)])
  v(3pt)
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
