// Cover letter — locked layout, styled by tokens.json.
// The agent writes content.json only. Tokens come from the user's chosen
// resume template, so the letter always matches the CV visually.

#let data = json("content.json")
#let t = json("tokens.json")

#let ink = rgb("#1A1A1A")
#let accent = rgb(t.accent)
#let gray = rgb(t.gray)

#set page(paper: "a4", margin: (x: 24mm, y: 22mm))
#set text(font: t.font, size: 11pt, fill: ink)
#set par(leading: 5pt, justify: true, spacing: 7pt)

#let contactline = text(size: 10pt, fill: gray)[
  #data.email · #data.mobile#for l in data.links [ · #text(fill: accent, link(l.url)[#l.label])]
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
#v(7pt)

#if t.rule == "bar" {
  rect(width: 100%, height: 3pt, fill: accent, stroke: none)
} else if t.rule == "hairline" {
  line(length: 100%, stroke: 0.5pt + gray)
} else {
  line(length: 100%, stroke: 0.8pt + accent)
}
#v(12pt)

#text(data.date)
#v(12pt)

#if "recipient_name" in data {
  text(data.recipient_name)
  linebreak()
}
#if "recipient_title" in data {
  text(data.recipient_title)
  linebreak()
}
#text(weight: "bold", data.company)
#for a in data.address_lines {
  linebreak()
  text(a)
}
#v(12pt)

#text(data.salutation)
#v(7pt)

#for p in data.paragraphs {
  p
  v(7pt)
}

#v(6pt)
#text(data.closing)
#v(20pt)
#text(weight: "bold", data.full_name)
