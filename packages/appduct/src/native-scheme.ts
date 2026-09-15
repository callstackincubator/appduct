/**
 * Static-file scheme discovery for plain iOS (Xcode) and Android (Gradle) apps
 * (docs/tasks/20-cli-native-scheme-discovery.md, phase 3 of issue #48).
 *
 * `scheme.ts`'s `resolveScheme` treats this module as one more thing to try after `<cwd>/app.json`
 * — it never walks up (an app root is where these commands run, same rule as `app.json`), and,
 * like every other source in that file, **nothing here executes project code**: no `plutil`, no
 * `xcodebuild`, no Gradle evaluation. Every probe is a plain read of a well-known project file,
 * parsed defensively:
 *
 * - Android: `app/build.gradle.kts` / `app/build.gradle` for a `manifestPlaceholders["appductScheme"]`
 *   (or `.appductScheme =`) assignment, then `app/src/main/AndroidManifest.xml` for the first
 *   `<data android:scheme>` inside an intent filter that also declares
 *   `android.intent.action.VIEW`.
 * - iOS: any `Info.plist` up to two levels below the app root (excluding `Pods`, `build`,
 *   `node_modules` and `DerivedData` — vendored/build-output trees that are not the project's own
 *   config, and can be enormous) for the first `CFBundleURLSchemes` entry, then `project.yml`
 *   (xcodegen) for the same key under `info.properties.CFBundleURLTypes`.
 *
 * A binary-encoded `Info.plist` (Xcode can write either encoding) is reported as unreadable rather
 * than decoded — `plutil -convert xml1` would work, but that is exactly the "run a tool against
 * project state" this module exists to avoid, so a binary plist just falls through to `--scheme`
 * like any other file this can't make sense of.
 *
 * **Disagreement is not guessed away.** If more than one probe below resolves to a *different*
 * scheme (e.g. a monorepo whose `android/` and `ios/` declare different values), discovery throws
 * a usage error naming every conflicting source instead of picking one — silently choosing would
 * mean `appduct link` opens the wrong app on whichever platform lost.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { firstConfiguredScheme, isValidScheme } from "./scheme.js";
import { usageError } from "./errors.js";

export type NativeSchemeSource =
  | "android-gradle"
  | "android-manifest"
  | "ios-info-plist"
  | "ios-project-yml";

export type NativeSchemeProbeResult = {
  source: NativeSchemeSource;
  scheme: string;
  /** Human-readable path (plus what was read from it), for disagreement errors and `init`'s hint. */
  origin: string;
};

export type NativeSchemeDiscovery = {
  /** `undefined` when no probe resolved a scheme. */
  result?: NativeSchemeProbeResult;
  /** Every probe's human-readable description, in order, for {@link describeMissingScheme}-style
   * reporting — always as many entries as there are probes, whether or not any of them hit. */
  tried: string[];
};

// --- shared file-reading caps ---

/** A `build.gradle`/`AndroidManifest.xml`/`Info.plist`/`project.yml` this large is not a file
 * these probes are meant to read — treated the same as "not found" rather than buffering an
 * arbitrarily large file into memory for a single regex/parse pass. */
const MAX_PROBE_FILE_BYTES = 2 * 1024 * 1024;

/** Depth-limited walk cap for the `Info.plist` search: 0 = the app root itself, 1 = its immediate
 * subdirectories, 2 = one level below that (where `MyApp.xcodeproj`'s sibling `Info.plist` and a
 * typical `MyApp/Info.plist` both live). */
const MAX_PLIST_WALK_DEPTH = 2;

/** Defensive cap on directory entries visited by the `Info.plist` walk, so a pathological tree
 * (a huge `node_modules` that slipped past the exclusion, a symlink farm) can't turn a static-file
 * probe into an unbounded scan. */
const MAX_WALK_ENTRIES = 5000;

/** Directories the `Info.plist` walk never descends into: vendored/build-output trees, not the
 * project's own config, and often enormous. */
const EXCLUDED_WALK_DIRS = new Set(["Pods", "build", "node_modules", "DerivedData"]);

type FileRead =
  | { ok: true; text: string }
  | { ok: false; reason: "not-found" | "too-large" | "unreadable" };

type BufferRead =
  | { ok: true; data: Buffer }
  | { ok: false; reason: "not-found" | "too-large" | "unreadable" };

/** Reads a file as text, capped at {@link MAX_PROBE_FILE_BYTES}. A missing file, a directory where
 * a file was expected, or a permission error are all "nothing usable here" — a caller falls
 * through to the next probe rather than treating any of these as a hard failure. */
const readCappedText = async (path: string): Promise<FileRead> => {
  const buffer = await readCappedBuffer(path);

  if (!buffer.ok) {
    return buffer;
  }

  return { ok: true, text: buffer.data.toString("utf8") };
};

const readCappedBuffer = async (path: string): Promise<BufferRead> => {
  let size: number;

  try {
    const stats = await stat(path);

    if (!stats.isFile()) {
      return { ok: false, reason: "not-found" };
    }

    size = stats.size;
  } catch {
    return { ok: false, reason: "not-found" };
  }

  if (size > MAX_PROBE_FILE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  try {
    return { ok: true, data: await readFile(path) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
};

/** A probe-reported scheme still has to be a legal URI scheme — the same rule every other source
 * in `scheme.ts` enforces, so a typo'd placeholder fails with a clear message instead of composing
 * an unopenable deep link three commands later. */
const requireValidNativeScheme = (value: string, origin: string): string => {
  if (!isValidScheme(value)) {
    throw usageError(
      `Invalid deep-link scheme ${JSON.stringify(value)} from ${origin}: a scheme must start with ` +
        'a letter and contain only letters, digits, "+", "-" or "." (for example "myapp") — do not ' +
        'include "://".',
    );
  }

  return value;
};

// --- Android: build.gradle(.kts) "appductScheme" placeholder ---

/**
 * Matches both Groovy DSL (`manifestPlaceholders["appductScheme"] = "myapp"`) and Kotlin DSL
 * (`manifestPlaceholders["appductScheme"] = "myapp"` or the property form
 * `manifestPlaceholders.appductScheme = "myapp"`) — issue #48's sketch shows the bracket form
 * for both, but the property form is common enough in real `build.gradle.kts` files to accept too.
 */
const GRADLE_PLACEHOLDER_PATTERN =
  /manifestPlaceholders\s*(?:\[\s*["']appductScheme["']\s*\]|\.\s*appductScheme)\s*=\s*["']([^"']*)["']/u;

const extractGradleScheme = (text: string): string | undefined => {
  const match = GRADLE_PLACEHOLDER_PATTERN.exec(text);
  const value = match?.[1];

  return value !== undefined && value.length > 0 ? value : undefined;
};

const probeAndroidGradle = async (root: string): Promise<NativeSchemeDiscovery> => {
  const candidates = [join(root, "app", "build.gradle.kts"), join(root, "app", "build.gradle")];
  const notes: string[] = [];

  for (const candidate of candidates) {
    const read = await readCappedText(candidate);

    if (!read.ok) {
      if (read.reason === "too-large") {
        notes.push(`${candidate} (too large, skipped)`);
      }

      continue;
    }

    const scheme = extractGradleScheme(read.text);

    if (scheme !== undefined) {
      requireValidNativeScheme(scheme, `"appductScheme" in ${candidate}`);

      return {
        result: {
          source: "android-gradle",
          scheme,
          origin: `"appductScheme" in ${candidate}`,
        },
        tried: [describeAndroidGradleTried(candidates, notes)],
      };
    }
  }

  return { tried: [describeAndroidGradleTried(candidates, notes)] };
};

const describeAndroidGradleTried = (candidates: string[], notes: string[]): string => {
  const base = `${candidates.join(", ")} ("appductScheme" manifest placeholder)`;

  return notes.length === 0 ? base : `${base} — ${notes.join(", ")}`;
};

// --- Android: AndroidManifest.xml <data android:scheme> in a VIEW intent filter ---

const INTENT_FILTER_PATTERN = /<intent-filter\b[^>]*>([\s\S]*?)<\/intent-filter>/giu;
const VIEW_ACTION_PATTERN = /<action\b[^>]*\bandroid:name\s*=\s*["']android\.intent\.action\.VIEW["']/iu;
const DATA_SCHEME_PATTERN = /<data\b[^>]*\bandroid:scheme\s*=\s*["']([^"']*)["']/iu;

/** The first `<data android:scheme>` inside an intent filter that also declares
 * `android.intent.action.VIEW` — a filter for some other action (`SEND`, `MAIN`, ...) is not a
 * deep-link scheme declaration and is skipped even if it happens to carry a `<data>` tag. */
const extractManifestScheme = (xml: string): string | undefined => {
  for (const match of xml.matchAll(INTENT_FILTER_PATTERN)) {
    const block = match[1] ?? "";

    if (!VIEW_ACTION_PATTERN.test(block)) {
      continue;
    }

    const dataMatch = DATA_SCHEME_PATTERN.exec(block);
    const scheme = dataMatch?.[1];

    if (scheme !== undefined && scheme.length > 0) {
      return scheme;
    }
  }

  return undefined;
};

const probeAndroidManifest = async (root: string): Promise<NativeSchemeDiscovery> => {
  const manifestPath = join(root, "app", "src", "main", "AndroidManifest.xml");
  const read = await readCappedText(manifestPath);
  const description = `${manifestPath} (first <data android:scheme> in a VIEW intent-filter)`;

  if (!read.ok) {
    return {
      tried: [read.reason === "too-large" ? `${description} — too large, skipped` : description],
    };
  }

  const scheme = extractManifestScheme(read.text);

  if (scheme === undefined) {
    return { tried: [description] };
  }

  requireValidNativeScheme(scheme, `"android:scheme" in ${manifestPath}`);

  return {
    result: {
      source: "android-manifest",
      scheme,
      origin: `"android:scheme" in ${manifestPath}`,
    },
    tried: [description],
  };
};

// --- iOS: Info.plist CFBundleURLSchemes (tolerant XML plist parsing) ---

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

type PlistNode = { tag: string; children: PlistNode[]; text: string };

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decodeXmlEntities = (text: string): string => {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/gu, (whole, entity: string) => {
    if (entity.startsWith("#x")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }

    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }

    return XML_ENTITIES[entity] ?? whole;
  });
};

/**
 * Turns an XML plist into a tree of tags — deliberately not a general/validating XML parser (no
 * DTD, no namespaces, no attribute parsing beyond stripping them): plist's grammar is small and
 * fixed (`dict`/`array`/`key`/`string`/`integer`/`real`/`true`/`false`/`date`/`data`), and being
 * tolerant of the ways a hand-written or generated `Info.plist` can still deviate slightly (a
 * stray unescaped `&`, mismatched nesting) matters more here than rejecting a technically-invalid
 * document.
 */
const tokenizePlistXml = (xml: string): PlistNode => {
  const cleaned = xml
    .replace(/<\?[\s\S]*?\?>/gu, "")
    .replace(/<!DOCTYPE[\s\S]*?>/giu, "")
    .replace(/<!--[\s\S]*?-->/gu, "");

  const root: PlistNode = { tag: "#root", children: [], text: "" };
  const stack: PlistNode[] = [root];
  const tagOrTextPattern = /<(\/?)([a-zA-Z][\w.:-]*)\b[^>]*?(\/?)>|([^<]+)/gu;

  for (const match of cleaned.matchAll(tagOrTextPattern)) {
    const [, closing, name, selfClosing, text] = match;
    // `stack` always has `root` at index 0 and is only ever popped down to length 1, so the top
    // is never actually undefined — the non-null assertion just satisfies noUncheckedIndexedAccess.
    const top = stack[stack.length - 1]!;

    if (text !== undefined) {
      top.text += decodeXmlEntities(text);
      continue;
    }

    if (closing) {
      if (stack.length > 1) {
        stack.pop();
      }

      continue;
    }

    const node: PlistNode = { tag: name ?? "", children: [], text: "" };
    top.children.push(node);

    if (!selfClosing) {
      stack.push(node);
    }
  }

  return root;
};

const plistNodeToValue = (node: PlistNode): PlistValue => {
  switch (node.tag) {
    case "true":
      return true;
    case "false":
      return false;
    case "integer": {
      const value = Number.parseInt(node.text.trim(), 10);
      return Number.isNaN(value) ? node.text.trim() : value;
    }
    case "real": {
      const value = Number.parseFloat(node.text.trim());
      return Number.isNaN(value) ? node.text.trim() : value;
    }
    case "array":
      return node.children.map(plistNodeToValue);
    case "dict": {
      const result: Record<string, PlistValue> = {};

      for (let index = 0; index < node.children.length; index += 2) {
        const keyNode = node.children[index];
        const valueNode = node.children[index + 1];

        if (keyNode?.tag === "key" && valueNode !== undefined) {
          result[keyNode.text.trim()] = plistNodeToValue(valueNode);
        }
      }

      return result;
    }
    default:
      // "string", and every leaf type this probe has no specific use for (data, date): the text
      // content is the closest thing to a value, and is simply never read for those tags.
      return node.text.trim();
  }
};

/** `undefined` for anything that isn't a well-formed `<plist>…</plist>` document (including a
 * binary plist, whose bytes tokenize into garbage tag names rather than throwing). */
const parsePlistXml = (xml: string): PlistValue | undefined => {
  const root = tokenizePlistXml(xml);
  const plistNode = root.children.find((child) => child.tag === "plist");
  const valueNode = plistNode?.children[0];

  return valueNode ? plistNodeToValue(valueNode) : undefined;
};

/** Apple's magic number for a binary-encoded plist (`bplist00`/`bplist01`/...) — checked on the
 * raw bytes before any text decoding is attempted, since a binary plist's bytes are not valid
 * UTF-8 and decoding them first would just produce mangled tag soup instead of a clean signal. */
const isBinaryPlist = (buffer: Buffer): boolean => {
  return buffer.length >= 6 && buffer.subarray(0, 6).toString("latin1") === "bplist";
};

/** The first non-empty `CFBundleURLSchemes` entry across every `CFBundleURLTypes` dict, in array
 * order — mirrors `firstConfiguredScheme`'s "first entry wins" rule, extended to "first dict that
 * actually has one wins" since an app can declare more than one `CFBundleURLTypes` entry (custom
 * scheme plus a universal-link-only entry with no `CFBundleURLSchemes` at all, say). */
const firstPlistUrlScheme = (cfBundleURLTypes: unknown): string | undefined => {
  if (!Array.isArray(cfBundleURLTypes)) {
    return undefined;
  }

  for (const entry of cfBundleURLTypes) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const scheme = firstConfiguredScheme((entry as Record<string, unknown>).CFBundleURLSchemes);

    if (scheme !== undefined) {
      return scheme;
    }
  }

  return undefined;
};

type WalkHit = { path: string; depth: number };

/**
 * Every file named `filename` from `root` down to `maxDepth` levels, nearest first (ties broken by
 * path) — the deterministic order that decides which `Info.plist` is "the first one" when several
 * exist. Symlinks are never followed (matches `artifact-inspect.ts`'s `readAppDirectory`, same
 * reasoning: avoids loops, and a plist worth discovering is never reached only through one).
 */
const walkForFilename = async (
  root: string,
  filename: string,
  maxDepth: number,
): Promise<WalkHit[]> => {
  const hits: WalkHit[] = [];
  let visited = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visited >= MAX_WALK_ENTRIES) {
        return;
      }

      visited += 1;

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (EXCLUDED_WALK_DIRS.has(entry.name)) {
          continue;
        }

        if (depth < maxDepth) {
          await walk(join(dir, entry.name), depth + 1);
        }

        continue;
      }

      if (entry.isFile() && entry.name === filename) {
        hits.push({ path: join(dir, entry.name), depth });
      }
    }
  };

  await walk(root, 0);
  hits.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  return hits;
};

const probeIosInfoPlist = async (root: string): Promise<NativeSchemeDiscovery> => {
  const files = await walkForFilename(root, "Info.plist", MAX_PLIST_WALK_DEPTH);

  const describeSearch = (notes: string[]): string => {
    const base =
      files.length === 0
        ? `Info.plist up to ${MAX_PLIST_WALK_DEPTH} levels below ${root} (excluding Pods/build/` +
          "node_modules/DerivedData) — none found"
        : `${files.map((file) => file.path).join(", ")} (first "CFBundleURLSchemes" entry)`;

    return notes.length === 0 ? base : `${base} — ${notes.join(", ")}`;
  };

  const notes: string[] = [];

  for (const file of files) {
    const read = await readCappedBuffer(file.path);

    if (!read.ok) {
      notes.push(
        `${file.path} (${read.reason === "too-large" ? "too large, skipped" : "unreadable"})`,
      );
      continue;
    }

    if (isBinaryPlist(read.data)) {
      notes.push(`${file.path} (binary plist — unreadable, use --scheme)`);
      continue;
    }

    const value = parsePlistXml(read.data.toString("utf8"));

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }

    const scheme = firstPlistUrlScheme((value as Record<string, unknown>).CFBundleURLTypes);

    if (scheme === undefined) {
      continue;
    }

    requireValidNativeScheme(scheme, `"CFBundleURLSchemes" in ${file.path}`);

    return {
      result: {
        source: "ios-info-plist",
        scheme,
        origin: `"CFBundleURLSchemes" in ${file.path}`,
      },
      tried: [describeSearch(notes)],
    };
  }

  return { tried: [describeSearch(notes)] };
};

// --- iOS: xcodegen's project.yml (info.properties.CFBundleURLTypes) ---

/**
 * Regex-based rather than a general YAML parser: `project.yml`'s `CFBundleURLTypes` shape is
 * exactly the plist one (an array of dicts, each with a `CFBundleURLSchemes` array or scalar), and
 * a full YAML grammar (anchors, flow vs. block collections, multiline scalars) is far more than
 * this one key needs. Matches both the inline flow form (`CFBundleURLSchemes: [myapp]`) and the
 * block sequence form (`CFBundleURLSchemes:\n  - myapp`), quoted or not.
 *
 * Deliberately *not* restricted to the legal scheme character set here (unlike the plist/Expo
 * path, which parses the value as a generic string first): capturing everything up to the
 * unambiguous YAML boundary (`]`, `,`, a quote, or the end of the line) and letting
 * {@link requireValidNativeScheme} reject it is what lets a genuinely malformed value (say,
 * `myapp://`) surface the same "invalid deep-link scheme" error the other three probes give,
 * instead of silently truncating it into something that looks valid.
 */
const PROJECT_YML_SCHEME_PATTERN =
  /CFBundleURLSchemes\s*:\s*(?:\[\s*["']?([^"'\],\r\n]*)["']?|\r?\n[ \t]*-[ \t]*["']?([^"'\r\n]*)["']?)/u;

const extractProjectYmlScheme = (text: string): string | undefined => {
  const match = PROJECT_YML_SCHEME_PATTERN.exec(text);
  const raw = (match?.[1] ?? match?.[2])?.trim();

  return raw !== undefined && raw.length > 0 ? raw : undefined;
};

const probeIosProjectYml = async (root: string): Promise<NativeSchemeDiscovery> => {
  const path = join(root, "project.yml");
  const description = `${path} ("info.properties.CFBundleURLTypes" > "CFBundleURLSchemes")`;
  const read = await readCappedText(path);

  if (!read.ok) {
    return {
      tried: [read.reason === "too-large" ? `${description} — too large, skipped` : description],
    };
  }

  const scheme = extractProjectYmlScheme(read.text);

  if (scheme === undefined) {
    return { tried: [description] };
  }

  requireValidNativeScheme(scheme, `"CFBundleURLSchemes" in ${path}`);

  return {
    result: { source: "ios-project-yml", scheme, origin: `"CFBundleURLSchemes" in ${path}` },
    tried: [description],
  };
};

// --- orchestration ---

/** In the order the file-level doc comment (and issue #48) describes: Android before iOS, and
 * within each platform the build config before the manifest/project file that mirrors it. */
const PROBES: Array<(root: string) => Promise<NativeSchemeDiscovery>> = [
  probeAndroidGradle,
  probeAndroidManifest,
  probeIosInfoPlist,
  probeIosProjectYml,
];

/**
 * Runs every static-file probe against `root` (never walking up — same rule as `app.json`) and
 * decides the result:
 *
 * - No probe resolves a scheme: `result` is `undefined`.
 * - Every probe that resolves one agrees: that scheme wins, attributed to whichever probe ran
 *   first (the order in {@link PROBES}).
 * - Two probes resolve *different* schemes: throws a usage error naming both sources and their
 *   values, since guessing which one is right would silently target the wrong app on one
 *   platform.
 *
 * `tried` always has one entry per probe, hit or miss, so a "no scheme anywhere" error can list
 * every location this looked without the caller needing to know which probes exist.
 */
export const discoverNativeScheme = async (root: string): Promise<NativeSchemeDiscovery> => {
  const tried: string[] = [];
  const results: NativeSchemeProbeResult[] = [];

  for (const probe of PROBES) {
    const outcome = await probe(root);
    tried.push(...outcome.tried);

    if (outcome.result !== undefined) {
      results.push(outcome.result);
    }
  }

  if (results.length === 0) {
    return { tried };
  }

  const distinctSchemes = new Set(results.map((entry) => entry.scheme));

  if (distinctSchemes.size > 1) {
    throw usageError(
      "Conflicting deep-link schemes found in this project: " +
        results.map((entry) => `${entry.origin} says ${JSON.stringify(entry.scheme)}`).join(", but ") +
        ". Appduct will not guess which one is right — pass --scheme <scheme> to pick one.",
    );
  }

  return { result: results[0], tried };
};
