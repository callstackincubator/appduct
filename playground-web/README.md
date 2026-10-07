# playground-web

A plain Vite and React page that registers the five demo tools the other playgrounds register,
through `@appduct/web/react`, and declares one event, `playground_ping`, that its button sends.

```bash
pnpm build
pnpm --filter playground-web dev
pnpm exec appduct sessions link --open web http://localhost:5173/
```

`pnpm exec appduct tools ls` lists the tools, and `appduct events tail` shows the pings. The
Vite dev server uses the `development` export condition, so Appduct is enabled; a production
build leaves it out. `packages/appduct/src/__tests__/e2e/playground-web-vite.e2e.test.ts`
drives this page through the CLI.
