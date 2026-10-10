# Appduct design

Near-black, one bright accent, white type. Light grotesk headlines, uppercase mono for
everything that labels. Square corners, 1px hairlines, no shadows, no gradients. Imagery is
dithered pixel art in the accent, never photos or illustrations. It is the Callstack product
look shared with Apex (lime) and Simlock (orange); Appduct's accent is cyan.

## Colour

Dark is the default and the only mode for marketing surfaces.

| Token | Value | Use |
| --- | --- | --- |
| `bg` | `#0a0a0a` | Page background |
| `surface` | `#111111` | Hovered cells, panels |
| `field` | `#161616` | Inputs, inline code, chips |
| `line` | `rgb(255 255 255 / 0.08)` | Hairlines: frame, section rows, cell borders |
| `line-strong` | `rgb(255 255 255 / 0.16)` | Window and input borders, outlined buttons |
| `text` | `#ffffff` | Headlines, primary text |
| `muted` | `rgb(255 255 255 / 0.62)` | Body copy, nav links |
| `faint` | `rgb(255 255 255 / 0.5)` | Metadata, section numbers, line numbers (the dimmest text that still passes 4.5:1) |
| `accent` | `#3ddcff` | Brand, primary actions, highlights |
| `accent-hover` | `#86ebff` | Hover on accent fills |
| `on-accent` | `#0a0a0a` | Text on accent fills, always dark |

- One accent, used sparingly: the wordmark, the primary action, the second beat of a headline,
  strings in code, live state in animations. Never for status (success, error, warning).
- Anything filled with the accent carries dark text.
- Docs in light mode: white background, black text, neutral greys, and a deeper cyan for
  accent text and links (`#007a99`, 4.95:1 on white) and for rules (`#0092b3`). The bright
  cyan stays only as a fill under dark text, such as the wordmark.
- Greys are neutral. No tinted greys.
- Every piece of text, code punctuation included, meets 4.5:1 against its background.

## Type

| Role | Font | Size | Weight | Tracking | Leading |
| --- | --- | --- | --- | --- | --- |
| Hero headline | Switzer | `clamp(2rem, 1.3rem + 2.6vw, 3.5rem)` | 500 | -0.035em | 1.08 |
| Section headline | Switzer | `clamp(1.75rem, 1.3rem + 1.6vw, 2.75rem)` | 500 | -0.03em | 1.1 |
| Card title | Switzer | 1.125rem | 500 | -0.01em | 1.3 |
| Lede | Switzer | 1–1.125rem | 400 | 0 | 1.55, `muted` |
| Body | Switzer | 0.9375rem | 400 | 0 | 1.55, `muted` |
| Label | Geist Mono | 0.75rem | 400 | 0.08em, UPPERCASE | — |
| Code | Geist Mono | 0.8125rem | 400 | 0 | 1.75 |
| Closing wordmark | Switzer | as wide as the frame (~21.6% of its width) | 500 | -0.045em | 0.8, `accent` |

- Fonts are free: Switzer (Fontshare, ITF Free Font License) and Geist Mono (OFL),
  self-hosted. No paid or proprietary fonts. Fallbacks: Arial; system monospace.
- Headlines run two beats; the second is in the accent: "Your app is an *MCP server now.*"
  No italics.
- The motto, used as the hero headline, on the social card and on the banner: "Your app is an
  MCP server now."
- Platforms are always listed in this order: iOS, Android, React Native, Flutter, Web.
- Mono labels carry structure: nav links, buttons, tabs, section numbers, package names,
  metadata. Sentences are never mono.

## Layout

- **The frame.** Content sits in one centred column, `min(100% - 2 × gutter, 75rem)`, whose
  left and right `line` hairlines run the full page height. Gutter `clamp(1rem, 3vw, 2rem)`;
  inner padding `clamp(1.25rem, 3vw, 2.5rem)`.
- **Sections** open on a full-width hairline row: `[01]  HOW IT WORKS` in mono, the number
  in `faint`. Then a headline block with generous top padding, then content.
- **Cells.** Grids of equal cells divided by `line` hairlines (right and bottom borders),
  no gaps, no fills. A cell that is a link fills with `surface` on hover.
- **Spacing** steps in 4px; section rhythm `clamp(2.5rem, 6vw, 5rem)`.
- Corner radius is 0 everywhere. No shadows, no blur except the sticky nav's backdrop.
- Phone width: one column, 16px side gutter, never horizontal scroll.

## Components

- **Wordmark.** "APPDUCT" in Switzer 500, uppercase, `on-accent` on an `accent` block with
  tight padding, followed by a `BY CALLSTACK` mono chip in `muted` on `#1a1a1a` (dropped on
  phones). The block is the bright cyan in every theme.
- **Nav.** Sticky, `rgb(10 10 10 / 0.86)` with backdrop blur, hairline under it. Wordmark left,
  mono links centred, a dark `GET STARTED` button right.
- **Buttons.** Mono uppercase 0.75rem, 2.5rem tall, square. Primary: accent fill, dark text.
  Dark: `#1a1a1a` fill, white text. 120ms colour transitions.
- **CTA bar.** The main call to action is a full-frame-width accent block,
  `clamp(4.5rem, 9vw, 7rem)` tall, a mono label centred: `GET STARTED →`.
- **Window.** For code and terminals: `bg` fill, `line-strong` border, a bar with a mini
  accent wordmark tag, a mono title in `faint` (file name or `zsh`/`agent`) and three thin
  window controls (×, –, □) on the right.
- **Code.** Zero-padded line numbers (`01`, `02`) in `faint`, keywords and punctuation in
  dimmed white, functions and types in white, strings and numbers in the accent. Empty
  numbered lines pad short snippets to a common height. In the docs, code blocks are framed
  by a hairline only: no accent rule, no line numbers. No ASCII diagrams; they overflow.
- **Command bar.** `$` in the accent, the command in mono, a `COPY` label button on the right,
  `line-strong` border.
- **Tabs.** Equal-width cells across the frame, mono labels in `faint`; the selected tab is
  white with a 2px accent underline.
- **Marquee.** A hairline row of mono labels scrolling left (about 38s per loop), each led by
  a 6px accent square, ends faded with a mask. Pauses on hover; static under reduced motion.
- **Pixel icons.** Drawn on a 9×9 grid, one square per pixel, `currentColor`, rendered at
  multiples of 9px with crisp edges.
- **Device frames.** Phones are dark (`#050505`) rectangles with pixel-stepped corners (4px
  steps, never rounded) and a 1px `#313131` outline that follows every step without a break,
  a black notch block (iPhone) or punch hole and three-square nav bar (Android). Browsers get a
  three-square chrome bar and a mono URL field. Apps inside are minimal: a header with the
  screen title flush left and a count in a small square on the right (accent when non-zero),
  Switzer UI text, mono prices and labels, product imagery as dot or line patterns.
- **Closing.** CTA bar, then the giant accent wordmark, then a single footer row:
  `© YEAR APPDUCT BY CALLSTACK` left, mono links right.

## Pixel imagery

All imagery is ordered dithering of a generated scene, drawn on canvas.

- **Grain:** 2 CSS px cells, scaled with `image-rendering: pixelated`. Fully filled cells,
  no gaps.
- **Palette:** three tones, `bg` → a 30% mix of the accent into `bg` → the accent, with a
  4×4 Bayer threshold between neighbouring tones.
- **Scenes:**
  - *Ducts* (the signature): six tubes enter from the left edge at different heights and
    bundle into one point where the app sits (`focus`, about 74% across), narrowing by 45% as
    they meet, with a gentle wave before they do. Radii run from 3.5% to 8.5% of the height;
    the two back tubes are dimmer (55%). Each tube is shaded as a lit cylinder, brightest
    about 40% above its centre line and dark at the edges, with corrugation rings every few
    cells drifting slowly. Short bright pulses (8% of the width) slide along the highlights
    toward the app, each tube at its own speed. Behind them, a faint haze around the focus.
    It reads as calls flowing through the duct into your app.
  - *Broken* (the 404 page only): the ducts with the front tube cut off short of the app. It
    ends in an open, dark ellipse with a lit rim; past it, a dashed accent line traces where the
    tube should run. Its pulses stop at the cut and the rim flares as each one arrives: a call
    that never reaches the app.
  - *Flow*: soft diagonal bands of light on black, slowly turning. For quieter backdrops
    behind code or commands.
- Windows and devices sit on top of the imagery with solid `bg` fills, so text never sits on
  dither.
- No mountains, landscapes, photos, gradients or 3D renders.

## Motion

- Animations tell the product story without captions: real code is typed, real app screens
  change, packets step between them.
- Pixel motion moves in steps (`steps(16)` easing, dither at about 12 fps), never smoothly.
- UI transitions: 120ms for hovers, about 300ms for screen changes.
- Text that types in is laid out at full length first and revealed, so nothing reflows. A
  morphing element sits in a slot sized for its largest state.
- Animation code loads only when its element first nears the viewport (a dynamic `import()`
  behind an IntersectionObserver), and loops run only while on screen. Under
  `prefers-reduced-motion` everything shows one meaningful still frame.

## Landing page

In order, each section in the frame:

1. **Nav.**
2. **Hero:** the motto as the headline ("Your app is an *MCP server now.*"), a one-sentence
   lede, a primary button and the install command bar. Beside them on wide screens, a window
   titled `agent · tools/list` showing the app's three tools as the agent sees them (name and
   argument in the accent, a plain-English line under each); hidden below 64rem. Then the race, on the
   ducts: two phones running the same app. Left, an agent taps through sign-in, three
   products and the cart, with a clock running at 5× and a tap counter. Right, the agent
   makes three MCP tool calls (`login`, `seed_cart`, `open_screen`) and reaches checkout in
   about three seconds; its clock turns into an accent block when it finishes.
3. **Marquee** of platforms and frameworks.
4. **[01] How it works:** platform tabs (iOS, Android, React Native, Flutter, Web) over a
   flow backdrop, each showing a window with the same `seed_cart` tool registered in that
   platform's code, and a strip with the package, one line about it and a setup link. Below,
   the pipeline on the ducts: a window on the left (agent, then test, then terminal), a
   dotted duct with packets stepping across, a device on the right that switches iPhone →
   Android → browser as each call lands.
5. **[02] Agents:** headline, one line, client chips, the MCP config in a window, and the
   skill install command on a flow band.
6. **[03] Why use it:** three cells, pixel icon, title, one sentence.
7. **[04] Platforms:** five link cells, name, package, one line, `SET UP →`.
8. **[05] Safe by default:** four cells, then links to the security and build-variant docs.
9. **[06] FAQ:** question-and-answer cells, three across.
10. **Closing:** CTA bar, giant wordmark, footer row.

## 404 page

Nav, then the broken ducts full-bleed in the frame with a solid card on top (left on wide
screens, above the scene on phones): a `404` accent chip with `PAGE NOT FOUND`, a two-beat
headline ("This page doesn't exist. *The rest of Appduct does.*"), the requested path as
inline code, Home and Docs buttons, Quick start and GitHub links. Then the giant wordmark and
the footer row. GitHub Pages serves it at any unknown path, so every URL on it is absolute.

## Words

Short, plain, colleague-to-colleague. Lead with the agent: Appduct turns a running app into
tools an agent calls over MCP; tests and the terminal call them too. No marketing adjectives,
no "just" or "simply". Headlines in two beats; ledes one or two sentences.

## Social card and banner

- Open Graph card, 1200×630: the wordmark top left, the motto large ("Your app is an" in
  white, "MCP server now." in the accent), a band of ducts dither across the bottom with a
  window showing one agent tool call, and the platforms in a mono row bottom right.
- README banner, 1300×400 rendered at 2×: the same pieces side by side, copy on the left,
  the ducts and the window on the right.

## Where it is implemented

- Landing tokens and base styles: `website/src/styles/landing.css`
- Docs theme, dark and light: `website/src/styles/theme.css`, `website/src/styles/docs.css`,
  `website/ec.config.mjs`
- Dithered scenes: `website/src/components/landing/dither.ts`
- Components: `website/src/components/landing/`
- Social card and README banner: `website/og/og.html`, rendered with
  `pnpm --filter @appduct/website og`
