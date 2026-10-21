import type { E2EConfig } from "e2e";
import { mobile } from "@e2e-dev/mobile";
import { web } from "@e2e-dev/web";
import { appductTools } from "@appduct/e2e";
import { scriptedModel } from "./scripted-model.ts";

export default {
  targets: [
    { name: "web", engine: web(), app: { url: process.env.APP_URL ?? "http://localhost:5199" } },
    { name: "android", engine: mobile({ platform: "android", device: process.env.ANDROID_DEVICE }), app: { bundleId: "com.callstack.appduct.playground" } },
    { name: "ios", engine: mobile({ platform: "ios", device: process.env.IOS_DEVICE }), app: { bundleId: "com.callstack.appduct.playgroundnative" } },
  ],
  agents: { default: { model: scriptedModel(), tools: appductTools() } },
  workers: 1,
} satisfies E2EConfig;
