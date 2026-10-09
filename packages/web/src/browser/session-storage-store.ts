import type { SessionStore } from "../core/index.js";

const KEY = "appduct.session";

/** `sessionStorage` survives a reload but not a new tab, which is the resume scope the web entry
 * promises. */
export const createSessionStorageStore = (): SessionStore => ({
  read: () => sessionStorage.getItem(KEY),
  write: (value) => sessionStorage.setItem(KEY, value),
  clear: () => sessionStorage.removeItem(KEY),
});
