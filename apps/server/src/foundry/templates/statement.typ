// Statement (personal statement / statement of purpose) — locked layout,
// styled by tokens.json to match the user's chosen resume template.

#let data = json("content.json")
#let t = json("tokens.json")

#let ink = rgb("#1A1A1A")
#let accent = rgb(t.accent)
#let gray = rgb(t.gray)

#set page(paper: "a4", margin: (x: 24mm, y: 22mm))
#set text(font: t.font, size: 11pt, fill: ink)
#set par(leading: 5pt, justify: true, spacing: 7pt)

#let contactline = text(size: 10pt, fill: gray)[
  #data.email · #data.mobile
]

#if t.header == "center" {
  align(center)[
    #text(size: 22pt, weight: "bold", data.full_name)
    #v(3pt)
    #contactline
  ]
} else {
  text(size: 22pt, weight: "bold", data.full_name)
  v(3pt)
  contactline
}
#v(10pt)

#if t.header == "center" {
  align(center, text(size: 15pt, weight: "bold", tracking: 2pt, upper(data.title)))
} else {
  text(size: 15pt, weight: "bold", tracking: 2pt, upper(data.title))
}
#v(4pt)

#if t.rule == "bar" {
  rect(width: 100%, height: 3pt, fill: accent, stroke: none)
} else if t.rule == "hairline" {
  line(length: 100%, stroke: 0.5pt + gray)
} else {
  line(length: 100%, stroke: 0.8pt + accent)
}
#v(12pt)

#for p in data.paragraphs {
  p
  v(7pt)
}

#v(14pt)
#text(data.date)
#linebreak()
#text(weight: "bold", data.full_name)
