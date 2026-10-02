// Template One — "Classic Cream".
// Locked design. The agent writes content.json only; it never edits this file.
//
// Reference: cream page, framed border, large serif name, blue links,
// centered letterspaced section headings with rules, circle bullets.

#let data = json("content.json")

#let ink = rgb("#1A1A1A")
#let blue = rgb("#1D4ED8")
#let frame = rgb("#C9BCA1")
#let rule-ink = rgb("#8A7F63")

#set page(
  paper: "a4",
  margin: (x: 17mm, y: 15mm),
  fill: rgb("#FCF6E8"),
  background: place(
    dx: 8mm,
    dy: 8mm,
    rect(width: 194mm, height: 281mm, stroke: 0.8pt + frame),
  ),
)

#set text(font: "Liberation Serif", size: 9.5pt, fill: ink)
#set par(leading: 3.5pt, justify: true, spacing: 5pt)
#set list(marker: text("○", size: 6.5pt, baseline: 1pt), indent: 10pt, body-indent: 7pt, spacing: 4pt)

// ---------- header ----------
#grid(
  columns: (1fr, auto),
  gutter: 8pt,
  [
    #text(size: 29pt, weight: "bold", data.full_name)
    #v(3pt)
    #for l in data.links {
      text(fill: blue, size: 9.5pt, link(l.url)[#l.label])
      linebreak()
    }
  ],
  align(right)[
    #text(size: 9.5pt)[Email: #text(fill: blue, data.email)] \
    #text(size: 9.5pt)[Mobile: #text(fill: blue, data.mobile)]
  ],
)
#v(4pt)

// ---------- sections ----------
#let section(title) = {
  v(6pt)
  line(length: 100%, stroke: 0.7pt + rule-ink)
  v(1pt)
  align(center, text(size: 11pt, weight: "bold", tracking: 2.5pt, upper(title)))
  v(1pt)
  line(length: 100%, stroke: 0.7pt + rule-ink)
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
    [#text(size: 9.5pt, e.dates)],
  )
  for b in e.bullets [
    - #b
  ]
  v(5pt)
}

// ---------- education ----------
#section("Education")
#for e in data.education {
  headrow([#text(weight: "bold", e.institution)], [#e.location])
  headrow([#e.degree], [#text(size: 9.5pt, e.dates)])
  v(3pt)
}

// ---------- skills ----------
#section("Skills Summary")
#for s in data.skills [
  - #text(weight: "bold")[#s.category:] #s.items
]

// ---------- experience ----------
#if data.experience.len() > 0 {
  section("Work Experience")
  for e in data.experience [#dated-entry(e)]
}

// ---------- projects ----------
#if data.projects.len() > 0 {
  section("Projects")
  for e in data.projects [#dated-entry(e)]
}

// ---------- certificates ----------
#if data.certificates.len() > 0 {
  section("Certificates")
  for e in data.certificates [#dated-entry(e)]
}
