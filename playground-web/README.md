<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct playground for Web

A Vite and React page that registers five demo tools through `@appduct/web/react`, plus a `playground_ping` event. Run it to try calling page functions from the CLI or an agent.

## Requirements

- Node 24 and pnpm 11.
- A browser on the same computer as the CLI.

## Getting started

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter playground-web dev
```

In another terminal, from the repository root:

```bash
node packages/appduct/bin.js sessions link --open web http://localhost:5173/
```

Open the URL the CLI prints in your browser.

## Try the tools

The app registers `sum`, `call_count`, `reset_counter`, `slow_task` and `throwing_tool`, plus the `playground_ping` event. After connecting:

```bash
node packages/appduct/bin.js tools ls
node packages/appduct/bin.js tools call sum --input '{"a":2,"b":3}'
node packages/appduct/bin.js tools call call_count --input '{}'
node packages/appduct/bin.js events ls
node packages/appduct/bin.js events tail --follow
```

`sum` returns `{"total":5}`. Press the page's ping button to see an event in the terminal. See the [playground contract](../docs/internal/playground-contract.md) for all tool names, groups and screen identifiers.

## Things to know

- **Reloading resumes the session.** Opening a new tab requires a new link.
- **The dev server enables Appduct.** A production build uses the inert entry; see [Web build variants](https://callstackincubator.github.io/appduct/guides/build-variants/#web-production-builds).
- **The page has its own UI identifiers.** It uses `#count` and `#ping`; the demo tool names follow the playground contract. `packages/appduct/src/__tests__/e2e/playground-web-vite.e2e.test.ts` drives the page through the CLI.

## Learn more

- [Web SDK](../packages/web/README.md)
- [Drive a web page](https://callstackincubator.github.io/appduct/guides/web-pages/)
- [Connect an agent](https://callstackincubator.github.io/appduct/guides/agents/)

## License

[MIT](https://github.com/callstackincubator/appduct/blob/main/LICENSE). Made at [Callstack](https://callstack.com/).
