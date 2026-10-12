<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct website

The Appduct landing page and documentation, built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build). It is published at <https://callstackincubator.github.io/appduct/>.

## Requirements

Node 24 and pnpm 11. Banner and social-card rendering also need Chromium: `pnpm --filter appduct exec playwright-core install chromium`. Follow [the design guide](../docs/DESIGN.md) for visual changes.

## Getting started

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @appduct/website dev        # http://localhost:4321/appduct/
```

## Common tasks

From the repository root:

```bash
pnpm --filter @appduct/website build      # static site in website/dist
pnpm --filter @appduct/website preview    # serve the built site
pnpm --filter @appduct/website typecheck  # astro check
pnpm --filter @appduct/website og         # re-render the README banner, social card and icons
```

The build fails on a broken internal link between docs pages (checked by `starlight-links-validator`).

## Where things live

| Path | What it is |
| --- | --- |
| `src/content/docs/` | Docs pages, one `.md`/`.mdx` file per page. The folder decides the sidebar group (`start`, `install`, `guides`, `reference`); `sidebar.order` in the frontmatter decides the position. Link between pages with site URLs such as `/appduct/start/quick-start/`. |
| `src/pages/index.astro` | The landing page, outside Starlight. Its copy is in `src/landing/content.ts`, which also feeds `src/pages/index.md.ts` (the page as Markdown for agents). |
| `src/components/landing/` | Landing page sections and animations. `dither.ts` draws the dithered pixel backgrounds. |
| `src/layouts/Landing.astro` | The landing page's `<head>`: SEO and social tags, structured data, links for agents. |
| `og/og.html`, `scripts/og.mjs` | The banner and link-preview card. `pnpm og` renders `.github/assets/readme-banner.png`, `public/og.png` and the PNG icons from `public/favicon.svg`. |
| `src/pages/[...slug].md.ts` | Serves every docs page as raw Markdown at `<page>.md`. |
| `src/components/` | Starlight component overrides: header title and links, footer, default dark theme. |
| `src/styles/` | The landing page look (`landing.css`), the docs theme (`theme.css`) and docs styling (`docs.css`). |
| `ec.config.mjs` | Code block themes. |
| `astro.config.mjs` | Site config, sidebar, and the `llms.txt` setup. |

The build also writes `llms.txt`, `llms-full.txt`, and `llms-small.txt` for LLMs, plus a sitemap.

## Deployment

[`.github/workflows/website.yaml`](../.github/workflows/website.yaml) builds the site on every pull request that touches it and deploys `website/dist` to GitHub Pages on each push to `main`. The repository's Pages source must be set to **GitHub Actions**.

## Learn more

- [Design guide](../docs/DESIGN.md)
- [Documentation site](https://callstackincubator.github.io/appduct/)

## License

[MIT](https://github.com/callstackincubator/appduct/blob/main/LICENSE). Made at [Callstack](https://callstack.com/).
