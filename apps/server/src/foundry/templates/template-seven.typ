// Template Seven — "ATS Classic".
// Locked design. The plain US workhorse: all black, serif, centered header,
// full-width rules, zero decoration — maximum parser compatibility.

#let data = json("content.json")

#let ink = rgb("#000000")

#set page(paper: "a4", margin: (x: 20mm, y: 16mm))
#set text(font: "Liberation Serif", size: 10.5pt, fill: ink)
#set par(leading: 3pt, justify: true, spacing: 4pt)
#set list(marker: text("•", size: 8pt), indent: 12pt, body-indent: 6pt, spacing: 3pt)

#align(center)[
  #text(size: 18pt, weight: "bold", data.full_name)
  #v(2pt)
  #text(size: 10pt)[
    #data.email | #data.mobile
    #for l in data.links [ | #link(l.url)[#l.label]]
  ]
]
#v(4pt)

#let section(title) = {
  v(8pt)
  text(size: 11pt, weight: "bold", upper(title))
  v(2pt)
  line(length: 100%, stroke: 1pt)
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
    [ | #if "tag_url" in e [#link(e.tag_url)[#e.tag]] else [#e.tag]]
  ]
}

#let dated-entry(e) = {
  headrow(
    [#text(weight: "bold", e.title)#taglink(e)],
    [#text(weight: "bold", e.dates)],
  )
  for b in e.bullets [
    - #b
  ]
  v(5pt)
}

#section("Education")
#for e in data.education {
  headrow([#text(weight: "bold", e.institution)], [#text(weight: "bold", e.location)])
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
  section("Certifications")
  for e in data.certificates [#dated-entry(e)]
}
