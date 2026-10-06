/**
 * `@appduct/web` outside the `development` export condition: the same API as `./enabled` with no
 * session client, so a production bundle carries none of it. Import `@appduct/web/enabled` to
 * opt in.
 */
import { createInertAppduct } from "./inert/index.js";

const appduct = createInertAppduct({ warn: (message) => console.warn(message) });

export const { registerTool, registerEvent, postEvent, connect, disconnect } = appduct;
