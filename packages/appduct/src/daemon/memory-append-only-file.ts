/** In-memory {@link AppendOnlyFile} for tests: inspect the lines written and the backup, or make
 * appends fail. */

import type { AppendOnlyFile } from "./events-log.js";

export class MemoryAppendOnlyFile implements AppendOnlyFile {
  private current: string[] = [];
  private backup: string[] = [];
  private appendError: Error | undefined;

  async append(line: string): Promise<void> {
    if (this.appendError !== undefined) {
      throw this.appendError;
    }

    this.current.push(line);
  }

  async size(): Promise<number> {
    return this.current.reduce((total, line) => total + Buffer.byteLength(`${line}\n`), 0);
  }

  async rotate(): Promise<void> {
    this.backup = this.current;
    this.current = [];
  }

  /** Lines in the current file, without their newlines. */
  lines(): string[] {
    return [...this.current];
  }

  /** Lines in the backup, without their newlines. */
  backupLines(): string[] {
    return [...this.backup];
  }

  /** Makes every append throw `error` until called again with `undefined`. */
  failAppendsWith(error: Error | undefined): void {
    this.appendError = error;
  }
}
