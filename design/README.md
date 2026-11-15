# Design

- **Screens**: the clickable design has one page per screen (This month, Brain, Backlog, Library, Inbox, Settings,
  Phone share). It was drawn over the household's real library, so it is kept privately, outside this repository, until
  a copy with invented data replaces it; `docs/spec.md` §4 describes every screen.
- **Design system**: HomersLab's `tokens.css`, `components.css`, `motion.js` and `icons.js`. Copy them into
  `apps/web/src/design/`, never edit them.
- Links to the published design and to the running prototype are kept privately, outside this repository.

Design decisions to keep:

- Wallpaper (teal, sky, sage blooms) drifts slowly behind glass; reduced motion stops it.
- The budget bar is the control: two handles on the bar itself, the fill is the order total.
- Brain: ideas as nodes, size = books read, four rings = intro/core/deep/counterpoint, focus glows, gaps dashed,
  new ideas dashed purple. The Focus card on This month shows the same graph in miniature.
- Moves have fixed colours: Connect teal, Deepen blue, Broaden/Wildcard purple, Counterpoint orange, Intro/Fiction grey.
- Kids' themes use purple; every kids' pick shows its theme.
