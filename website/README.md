# Appduct website

The Appduct landing page and documentation, built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build). It is published at <https://callstackincubator.github.io/appduct/>.

## Run it

From the repository root:

```bash
pnpm install
pnpm --filter @appduct/website dev        # http://localhost:4321/appduct/
pnpm --filter @appduct/website build      # static site in website/dist
pnpm --filter @appduct/website preview    # serve the built site
pnpm --filter @appduct/website typecheck  # astro check
```

The build fails on a broken internal link between docs pages (checked by `starlight-links-validator`).

## Where things live

| Path | What it is |
| --- | --- |
| `src/content/docs/` | Docs pages, one `.md`/`.mdx` file per page. The folder decides the sidebar group (`start`, `guides`, `reference`); `sidebar.order` in the frontmatter decides the position. Link between pages with site URLs such as `/appduct/start/quick-start/`. |
| `src/pages/index.astro` | The landing page. |
| `src/pages/[...slug].md.ts` | Serves every docs page as raw Markdown at `<page>.md`. |
| `src/components/` | Starlight component overrides: header title and links, hero, footer, default dark theme. |
| `src/styles/` | The Callstack theme (`theme.css`) and docs styling (`docs.css`). |
| `ec.config.mjs` | Code block themes. |
| `astro.config.mjs` | Site config, sidebar, and the `llms.txt` setup. |

The build also writes `llms.txt`, `llms-full.txt`, and `llms-small.txt` for LLMs, plus a sitemap.

## Deploy

[`.github/workflows/website.yaml`](../.github/workflows/website.yaml) builds the site on every pull request that touches it and deploys `website/dist` to GitHub Pages on each push to `main`. The repository's Pages source must be set to **GitHub Actions**.
