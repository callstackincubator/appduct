import type { AppductClient } from "@appduct/shared/sdk";

import type { WebCorePorts } from "../core/index.js";
import type { PageEnv } from "./memory-page.js";

export { createMemoryPage, type MemoryPage, type PageEnv } from "./memory-page.js";

/** The plain-JS surface of `@appduct/web`. */
export type WebAppduct = Pick<
  AppductClient,
  "registerTool" | "registerEvent" | "postEvent" | "disconnect"
> & {
  /** Claims a session with the link from `appduct_connect`: the `#appduct=` value. */
  connect(link: string): Promise<void>;
};

export const createWebAppduct = (_options: { ports: WebCorePorts; page: PageEnv }): WebAppduct => {
  throw new Error("not implemented");
};
