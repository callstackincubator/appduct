/** {@link AppendOnlyFile} on the real filesystem; the backup is `<path>.1`. */

import { open, rename, stat } from "node:fs/promises";

import type { AppendOnlyFile } from "./events-log.js";

export class NodeAppendOnlyFile implements AppendOnlyFile {
  constructor(private readonly path: string) {}

  async append(line: string): Promise<void> {
    const handle = await open(this.path, "a", 0o600);

    try {
      await handle.appendFile(`${line}\n`);
      // `open`'s mode applies only at creation and is subject to umask; ARCHITECTURE.md §3 wants 0600.
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  }

  async size(): Promise<number> {
    try {
      return (await stat(this.path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }

      throw error;
    }
  }

  async rotate(): Promise<void> {
    // `rename` keeps the mode `append` set, and replaces any previous backup.
    await rename(this.path, `${this.path}.1`);
  }
}
