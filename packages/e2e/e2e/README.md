# @appduct/e2e suite

Runs `@appduct/e2e` through the e2e CLI against the playgrounds, the way a user's suite would.
`scripted-model.ts` stands in for a model, so the agent-tool test needs no provider. Not part of
`pnpm test`: it needs a browser, a running playground and, for mobile, a simulator or emulator.

```bash
pnpm build
pnpm --filter appduct exec playwright-core install chromium       # once
pnpm playground:web -- --port 5199                                # in another terminal
cd packages/e2e/e2e
../node_modules/.bin/e2e run --config ./e2e.config.ts --target web
```

For `--target ios` or `--target android`, install `playground-native` on the device first (see
`e2e-device/README.md`) and pin the device with `IOS_DEVICE=<udid>` or `ANDROID_DEVICE=<serial>`.
Set `APPDUCT_STATE_DIR` to a scratch directory holding `{"wssPort":0}` in `config.json` to keep the
suite's daemon away from yours.
