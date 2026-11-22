// mend — one patch tool for every AI edit format.
//
// Written from SPEC.md v1: it reads unified diffs, SEARCH/REPLACE blocks,
// V4A patches and JSON edit calls, matches the lines they name at three
// tiers of whitespace tolerance, and either writes every change or none.
// Node 22, standard library only, deterministic output.
//
// When the grader runs this file it sets MAKEFUN_ENV_URL; the last lines
// then hand the trial to runner.ts (kept from the kit, as instructed).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** A fatal problem with the patch itself: exit 2 with this single line. */
class Bail {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** One edit failed against the tree: exit 1 collects these. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlankText = (s: string): boolean => s.trim().length === 0;
const cutTrailWs = (s: string): string => s.replace(/\s+$/, "");
const cutSpaceTabRight = (s: string): string => s.replace(/[ \t]+$/, "");
const cutSpaceTabBoth = (s: string): string => s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
const leadSpaceTab = (s: string): string => /^[ \t]*/.exec(s)![0];

/** Patch text to patch lines: split at LF, drop one CR per line end. */
function toPatchLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
}

/** A path is safe when no segment can escape or confuse the tree root. */
function pathIsSafe(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("\\")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** A file as lines: its own break style, and whether it ends with one. */
interface FileDoc {
  lines: string[];
  eol: string;
  trailing: boolean;
}

function docFromText(text: string): FileDoc {
  const at = text.indexOf("\n");
  const eol = at > 0 && text.charAt(at - 1) === "\r" ? "\r\n" : "\n";
  if (text === "") return { lines: [], eol: "\n", trailing: false };
  const parts = text.split(eol);
  const trailing = text.endsWith(eol);
  if (trailing) parts.pop();
  return { lines: parts, eol, trailing };
}

function textFromDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return "";
  return doc.lines.join(doc.eol) + (doc.trailing ? doc.eol : "");
}

/**
 * The tree during a run. Disk contents are remembered once in `base`;
 * edits stage their results in `staged`, and nothing reaches the disk
 * unless every edit succeeds. Successful moves are remembered as pairs
 * so the report can print one R line instead of a D plus an A.
 */
class Store {
  private base = new Map<string, string | null>();
  staged = new Map<string, string | null>();
  moves: Array<readonly [string, string]> = [];

  baseOf(p: string): string | null {
    const hit = this.base.get(p);
    if (hit !== undefined || this.base.has(p)) return hit ?? null;
    let v: string | null = null;
    try {
      if (statSync(p).isFile()) v = readFileSync(p, "utf8");
    } catch {
      v = null;
    }
    this.base.set(p, v);
    return v;
  }

  read(p: string): string | null {
    return this.staged.has(p) ? this.staged.get(p)! : this.baseOf(p);
  }

  put(p: string, v: string | null): void {
    this.staged.set(p, v);
  }
}

type EditFn = (store: Store, strict: boolean) => void;

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers                            */
/* ------------------------------------------------------------------ */

function sameLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return cutSpaceTabRight(a) === cutSpaceTabRight(b);
  return cutSpaceTabBoth(a) === cutSpaceTabBoth(b);
}

function matchAt(lines: string[], needle: string[], at: number, tier: number): boolean {
  for (let k = 0; k < needle.length; k += 1) {
    if (!sameLine(lines[at + k]!, needle[k]!, tier)) return false;
  }
  return true;
}

/** Every start position of needle in lines at one tier, from `from`. */
function positionsAt(lines: string[], needle: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + needle.length <= lines.length; i += 1) {
    if (matchAt(lines, needle, i, tier)) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  positions: number[];
}

/** The first tier (0 only when strict) at which the needle occurs. */
function firstTier(lines: string[], needle: string[], strict: boolean, from: number): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = positionsAt(lines, needle, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One piece of a replacement: a matched file line, or a literal line. */
interface Piece {
  fixedAt: number; // >= 0: copy the file line this far into the match
  literal: string; // used when fixedAt < 0
}

/** Build the lines that replace a match, honouring section 5's rules. */
function buildReplacement(pieces: Piece[], fileLines: string[], at: number, tier: number, needle: string[]): string[] {
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece.fixedAt >= 0) {
      out.push(fileLines[at + piece.fixedAt]!);
      continue;
    }
    let line = piece.literal;
    if (tier === 2 && line !== "" && !/^[ \t]+$/.test(line)) {
      const p = leadSpaceTab(needle[0] ?? "");
      const f = leadSpaceTab(fileLines[at] ?? "");
      if (line.startsWith(p)) line = f + line.slice(p.length);
    }
    out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface BodyEntry {
  kind: "ctx" | "old" | "new";
  text: string;
  slash: boolean; // a "\ No newline" line follows this entry
  blankRaw: boolean; // the patch line itself was empty
}

interface Hunk {
  a: number;
  entries: BodyEntry[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  headOld?: string;
  headNew?: string;
  hasPair: boolean;
  renFrom?: string;
  renTo?: string;
  modeNew: boolean;
  modeDel: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return { hasPair: false, modeNew: false, modeDel: false, hunks: [] };
}

/** The path a --- or +++ line names: up to a tab, spaces trimmed, a/ b/ off. */
function headerPath(line: string): string {
  let raw = line.slice(4);
  const tab = raw.indexOf("\t");
  if (tab >= 0) raw = raw.slice(0, tab);
  raw = raw.trim();
  if (raw !== "/dev/null" && (raw.startsWith("a/") || raw.startsWith("b/"))) raw = raw.slice(2);
  return raw;
}

/** Whether the hunk's last context or + entry carries a "\ " marker. */
function lastPlusCtxSlash(hunk: Hunk): boolean {
  let slash = false;
  let seen = false;
  for (const e of hunk.entries) {
    if (e.kind === "ctx" || e.kind === "new") {
      slash = e.slash;
      seen = true;
    }
  }
  return seen ? slash : false;
}

function applyUnifiedHunk(doc: FileDoc, hunk: Hunk, strict: boolean, errPath: string, delta: number): number {
  const needle: string[] = [];
  const pieces: Piece[] = [];
  for (const e of hunk.entries) {
    if (e.kind === "ctx") {
      pieces.push({ fixedAt: needle.length, literal: "" });
      needle.push(e.text);
    } else if (e.kind === "old") {
      needle.push(e.text);
    } else {
      pieces.push({ fixedAt: -1, literal: e.text });
    }
  }
  if (needle.length === 0) {
    // Insert after the first A + d lines of the current file.
    let at = hunk.a + delta;
    if (at < 0) at = 0;
    if (at > doc.lines.length) at = doc.lines.length;
    const atEnd = at === doc.lines.length;
    const add = pieces.map((p) => p.literal);
    doc.lines.splice(at, 0, ...add);
    if (atEnd && add.length > 0) doc.trailing = !lastPlusCtxSlash(hunk);
    return delta + add.length;
  }
  const hit = firstTier(doc.lines, needle, strict, 0);
  if (hit === null) throw new EditFail("no-match", errPath);
  const target = hunk.a - 1 + delta;
  let chosen = hit.positions[0]!;
  for (const pos of hit.positions) {
    if (Math.abs(pos - target) < Math.abs(chosen - target)) chosen = pos;
  }
  const runsToEnd = chosen + needle.length === doc.lines.length;
  const replacement = buildReplacement(pieces, doc.lines, chosen, hit.tier, needle);
  doc.lines.splice(chosen, needle.length, ...replacement);
  if (runsToEnd) doc.trailing = !lastPlusCtxSlash(hunk);
  return delta + replacement.length - needle.length;
}

function unifiedEdits(lines: string[]): EditFn[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Bail(`error: parse ${i + 1}`);
      sec = newSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      i += 1;
      continue;
    }
    if (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      if (sec === null || sec.hasPair || sec.hunks.length > 0) {
        sec = newSection();
        sections.push(sec);
      }
      sec.headOld = headerPath(line);
      sec.headNew = headerPath(lines[i + 1]!);
      sec.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith("@@")) {
      if (sec === null) throw new Bail(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Bail(`error: parse ${i + 1}`);
      const entries: BodyEntry[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith("diff --git ")) break;
        if (b.startsWith("--- ") && (lines[j + 1] ?? "").startsWith("+++ ")) break;
        const c = b.charAt(0);
        if (b === "") entries.push({ kind: "ctx", text: "", slash: false, blankRaw: true });
        else if (c === " ") entries.push({ kind: "ctx", text: b.slice(1), slash: false, blankRaw: false });
        else if (c === "-") entries.push({ kind: "old", text: b.slice(1), slash: false, blankRaw: false });
        else if (c === "+") entries.push({ kind: "new", text: b.slice(1), slash: false, blankRaw: false });
        else if (c === "\\") {
          const prev = entries[entries.length - 1];
          if (prev !== undefined) prev.slash = true;
        } else break;
        j += 1;
      }
      while (entries.length > 0 && entries[entries.length - 1]!.blankRaw) entries.pop();
      sec.hunks.push({ a: Number(m[1]), entries });
      i = j;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // The section header, before its first hunk.
      if (line.startsWith("--- ")) throw new Bail(`error: parse ${i + 2}`);
      if (line.startsWith("+++ ")) {
        sec.headNew = headerPath(line);
        sec.hasPair = sec.headOld !== undefined;
      } else if (line.startsWith("rename from ")) sec.renFrom = line.slice(12).trim();
      else if (line.startsWith("rename to ")) sec.renTo = line.slice(10).trim();
      else if (line.startsWith("new file mode")) sec.modeNew = true;
      else if (line.startsWith("deleted file mode")) sec.modeDel = true;
    }
    // Anything else outside a hunk body is prose and is ignored.
    i += 1;
  }
  return sections.map((s) => sectionEdit(s));
}

function sectionEdit(s: Section): EditFn {
  return (store, strict) => {
    const rawOld = s.hasPair ? s.headOld : (s.renFrom ?? s.gitOld);
    const rawNew = s.hasPair ? s.headNew : (s.renTo ?? s.gitNew);
    const isCreate = rawOld === "/dev/null" || s.modeNew;
    const isDelete = rawNew === "/dev/null" || s.modeDel;
    const oldPath = rawOld === "/dev/null" ? undefined : rawOld;
    const newPath = rawNew === "/dev/null" ? undefined : rawNew;
    if (isCreate) {
      const p = newPath ?? "";
      if (!pathIsSafe(p)) throw new EditFail("unsafe", p);
      if (store.read(p) !== null) throw new EditFail("exists", p);
      const plus: string[] = [];
      let slash = false;
      for (const h of s.hunks) {
        for (const e of h.entries) {
          if (e.kind === "new") {
            plus.push(e.text);
            slash = e.slash;
          }
        }
      }
      store.put(p, textFromDoc({ lines: plus, eol: "\n", trailing: plus.length > 0 && !slash }));
      return;
    }
    if (isDelete) {
      const p = oldPath ?? "";
      if (!pathIsSafe(p)) throw new EditFail("unsafe", p);
      if (store.read(p) === null) throw new EditFail("missing", p);
      store.put(p, null);
      return;
    }
    const from = oldPath ?? "";
    const to = newPath ?? from;
    if (!pathIsSafe(from)) throw new EditFail("unsafe", from);
    const isMove = to !== from;
    if (isMove && !pathIsSafe(to)) throw new EditFail("unsafe", to);
    const before = store.read(from);
    if (before === null) throw new EditFail("missing", from);
    if (isMove && store.read(to) !== null) throw new EditFail("exists", to);
    const doc = docFromText(before);
    let delta = 0;
    for (const h of s.hunks) delta = applyUnifiedHunk(doc, h, strict, from, delta);
    if (isMove) {
      store.put(from, null);
      store.put(to, textFromDoc(doc));
      store.moves.push([from, to] as const);
    } else {
      store.put(from, textFromDoc(doc));
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[]): EditFn[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (cutTrailWs(lines[i]!) !== "<<<<<<< SEARCH") {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (cutTrailWs(lines[j]!) === "=======") {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (cutTrailWs(lines[j]!) === ">>>>>>> REPLACE") {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Bail(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k -= 1) {
      const cand = lines[k]!;
      if (isBlankText(cand)) continue;
      if (cand.trim().startsWith("```")) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Bail(`error: parse ${searchLine}`);
      path = prevPath;
    }
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => (store, strict) => {
    if (!pathIsSafe(b.path)) throw new EditFail("unsafe", b.path);
    if (b.oldLines.length === 0) {
      if (store.read(b.path) !== null) throw new EditFail("exists", b.path);
      store.put(b.path, textFromDoc({ lines: [...b.newLines], eol: "\n", trailing: b.newLines.length > 0 }));
      return;
    }
    const before = store.read(b.path);
    if (before === null) throw new EditFail("missing", b.path);
    const doc = docFromText(before);
    const hit = firstTier(doc.lines, b.oldLines, strict, 0);
    if (hit === null) throw new EditFail("no-match", b.path);
    if (hit.positions.length > 1) throw new EditFail("ambiguous", b.path);
    const at = hit.positions[0]!;
    const pieces: Piece[] = b.newLines.map((t) => ({ fixedAt: -1, literal: t }));
    const replacement = buildReplacement(pieces, doc.lines, at, hit.tier, b.oldLines);
    doc.lines.splice(at, b.oldLines.length, ...replacement);
    store.put(b.path, textFromDoc(doc));
  });
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: BodyEntry[];
}

interface VSection {
  kind: "add" | "del" | "upd";
  path: string;
  headerLine: number;
  fileLines: string[];
  moveTo?: string;
  chunks: VChunk[];
}

const V_HEADS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const;

function v4aSections(lines: string[], first: number, last: number): VSection[] {
  const out: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlankText(line)) {
      i += 1;
      continue;
    }
    const headIdx = V_HEADS.findIndex((h) => line.startsWith(h));
    if (headIdx < 0) throw new Bail(`error: parse ${i + 1}`);
    const kind = headIdx === 0 ? "add" : headIdx === 1 ? "del" : "upd";
    const path = line.slice(V_HEADS[headIdx]!.length).trim();
    const headerLine = i + 1;
    const content: Array<{ text: string; lineNo: number }> = [];
    let j = i + 1;
    while (j < last && !V_HEADS.some((h) => lines[j]!.startsWith(h))) {
      content.push({ text: lines[j]!, lineNo: j + 1 });
      j += 1;
    }
    // Blank lines at the end of a section are not part of it (section 8):
    // that includes a line of only spaces, such as a stray context marker.
    while (content.length > 0 && isBlankText(content[content.length - 1]!.text)) content.pop();
    const sec: VSection = { kind, path, headerLine, fileLines: [], chunks: [] };
    if (kind === "add") {
      for (const item of content) {
        if (item.text.startsWith("+")) sec.fileLines.push(item.text.slice(1));
        else if (item.text === "") sec.fileLines.push("");
        else throw new Bail(`error: parse ${item.lineNo}`);
      }
    } else if (kind === "del") {
      if (content.length > 0) throw new Bail(`error: parse ${content[0]!.lineNo}`);
    } else {
      let idx = 0;
      if (content.length > 0 && content[0]!.text.startsWith("*** Move to: ")) {
        sec.moveTo = content[0]!.text.slice("*** Move to: ".length).trim();
        idx = 1;
      }
      let cur: VChunk | null = null;
      for (; idx < content.length; idx += 1) {
        const item = content[idx]!;
        const t = item.text;
        if (t.startsWith("@@")) {
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === "" ? null : anchor, eof: false, entries: [] };
          sec.chunks.push(cur);
        } else if (cutTrailWs(t) === "*** End of File") {
          if (cur === null) {
            cur = { anchor: null, eof: true, entries: [] };
            sec.chunks.push(cur);
          } else cur.eof = true;
          cur = null;
        } else if (t === "" || t.startsWith(" ") || t.startsWith("-") || t.startsWith("+")) {
          if (cur === null) {
            cur = { anchor: null, eof: false, entries: [] };
            sec.chunks.push(cur);
          }
          const entryKind = t.startsWith("-") ? "old" : t.startsWith("+") ? "new" : "ctx";
          cur.entries.push({ kind: entryKind, text: t === "" ? "" : t.slice(1), slash: false, blankRaw: t === "" });
        } else {
          throw new Bail(`error: parse ${item.lineNo}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Bail(`error: parse ${headerLine}`);
    }
    out.push(sec);
    i = j;
  }
  return out;
}

function applyVChunk(doc: FileDoc, chunk: VChunk, strict: boolean, errPath: string, cursor: number): number {
  let cur = cursor;
  if (chunk.anchor !== null) {
    const tiers = strict ? [0] : [0, 1, 2];
    let found = -1;
    for (const tier of tiers) {
      for (let p = cur; p < doc.lines.length; p += 1) {
        if (sameLine(doc.lines[p]!, chunk.anchor, tier)) {
          found = p;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found < 0) throw new EditFail("no-match", errPath);
    cur = found + 1;
  }
  const needle: string[] = [];
  const pieces: Piece[] = [];
  for (const e of chunk.entries) {
    if (e.kind === "ctx") {
      pieces.push({ fixedAt: needle.length, literal: "" });
      needle.push(e.text);
    } else if (e.kind === "old") needle.push(e.text);
    else pieces.push({ fixedAt: -1, literal: e.text });
  }
  if (needle.length === 0) {
    const at = chunk.eof ? doc.lines.length : cur;
    const add = pieces.map((p) => p.literal);
    doc.lines.splice(at, 0, ...add);
    return at + add.length;
  }
  const tiers = strict ? [0] : [0, 1, 2];
  let hit: TierHit | null = null;
  for (const tier of tiers) {
    let positions = positionsAt(doc.lines, needle, tier, cur);
    if (chunk.eof) positions = positions.filter((p) => p + needle.length === doc.lines.length);
    if (positions.length > 0) {
      hit = { tier, positions };
      break;
    }
  }
  if (hit === null) throw new EditFail("no-match", errPath);
  const at = hit.positions[0]!;
  const replacement = buildReplacement(pieces, doc.lines, at, hit.tier, needle);
  doc.lines.splice(at, needle.length, ...replacement);
  return at + replacement.length;
}

function v4aEdits(lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlankText(l));
  if (first < 0) throw new Bail("error: parse 1");
  if (lines[first]!.trim() !== "*** Begin Patch") throw new Bail(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlankText(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== "*** End Patch") throw new Bail(`error: parse ${lines.length + 1}`);
  const sections = v4aSections(lines, first, last);
  return sections.map((s) => (store, strict) => {
    if (!pathIsSafe(s.path)) throw new EditFail("unsafe", s.path);
    if (s.kind === "add") {
      if (store.read(s.path) !== null) throw new EditFail("exists", s.path);
      store.put(s.path, textFromDoc({ lines: [...s.fileLines], eol: "\n", trailing: s.fileLines.length > 0 }));
      return;
    }
    if (s.kind === "del") {
      if (store.read(s.path) === null) throw new EditFail("missing", s.path);
      store.put(s.path, null);
      return;
    }
    if (s.moveTo !== undefined && !pathIsSafe(s.moveTo)) throw new EditFail("unsafe", s.moveTo);
    const before = store.read(s.path);
    if (before === null) throw new EditFail("missing", s.path);
    if (s.moveTo !== undefined && store.read(s.moveTo) !== null) throw new EditFail("exists", s.moveTo);
    const doc = docFromText(before);
    let cursor = 0;
    for (const chunk of s.chunks) cursor = applyVChunk(doc, chunk, strict, s.path, cursor);
    if (s.moveTo !== undefined) {
      store.put(s.path, null);
      store.put(s.moveTo, textFromDoc(doc));
      store.moves.push([s.path, s.moveTo] as const);
    } else {
      store.put(s.path, textFromDoc(doc));
    }
  });
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits                                               */
/* ------------------------------------------------------------------ */

function makeJsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== "string") return null;
  const p = o.path;
  if (o.command === "create") {
    if (typeof o.file_text !== "string") return null;
    const text = o.file_text;
    return (store) => {
      if (!pathIsSafe(p)) throw new EditFail("unsafe", p);
      if (store.read(p) !== null) throw new EditFail("exists", p);
      store.put(p, text);
    };
  }
  if (o.command === "str_replace") {
    if (typeof o.old_str !== "string" || o.old_str === "") return null;
    if (o.new_str !== undefined && typeof o.new_str !== "string") return null;
    const oldStr = o.old_str;
    const newStr = typeof o.new_str === "string" ? o.new_str : "";
    return (store) => {
      if (!pathIsSafe(p)) throw new EditFail("unsafe", p);
      const before = store.read(p);
      if (before === null) throw new EditFail("missing", p);
      const nl = before.indexOf("\n");
      const crlf = nl > 0 && before.charAt(nl - 1) === "\r";
      const toLf = (s: string): string => (crlf ? s.split("\r\n").join("\n") : s);
      const hay = toLf(before);
      const needle = toLf(oldStr);
      let count = 0;
      for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + 1)) count += 1;
      if (count === 0) throw new EditFail("no-match", p);
      if (count > 1) throw new EditFail("ambiguous", p);
      const at = hay.indexOf(needle);
      const joined = hay.slice(0, at) + toLf(newStr) + hay.slice(at + needle.length);
      store.put(p, crlf ? joined.split("\n").join("\r\n") : joined);
    };
  }
  if (o.command === "insert") {
    if (typeof o.insert_line !== "number" || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== "string") return null;
    const lineNo = o.insert_line;
    const addLines = toPatchLines(o.new_str);
    return (store) => {
      if (!pathIsSafe(p)) throw new EditFail("unsafe", p);
      const before = store.read(p);
      if (before === null) throw new EditFail("missing", p);
      const doc = docFromText(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new EditFail("no-match", p);
      doc.lines.splice(lineNo, 0, ...addLines);
      store.put(p, textFromDoc(doc));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlankText(l));
  if (first < 0) throw new Bail("error: parse 1");
  if (lines[first]!.trimStart().startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Bail(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(data)) throw new Bail(`error: parse ${first + 1}`);
    const edits: EditFn[] = [];
    for (const item of data) {
      const e = makeJsonEdit(item);
      if (e === null) throw new Bail(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Bail("error: parse 1");
    return edits;
  }
  const edits: EditFn[] = [];
  lines.forEach((line, idx) => {
    if (isBlankText(line)) return;
    let e: EditFn | null = null;
    try {
      e = makeJsonEdit(JSON.parse(line));
    } catch {
      e = null;
    }
    if (e === null) throw new Bail(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Bail("error: parse 1");
  return edits;
}

/* ------------------------------------------------------------------ */
/* Sections 1, 2, 4 and 10: the command line and the run as a whole    */
/* ------------------------------------------------------------------ */

const FORMAT_NAMES = ["auto", "unified", "search-replace", "v4a", "json"];

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlankText(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === "*** Begin Patch") return "v4a";
  const lead = lines[first]!.trimStart().charAt(0);
  if (lead === "[" || lead === "{") return "json";
  if (lines.some((l) => cutTrailWs(l) === "<<<<<<< SEARCH")) return "search-replace";
  const unified = lines.some(
    (l, idx) => l.startsWith("diff --git ") || (l.startsWith("--- ") && (lines[idx + 1] ?? "").startsWith("+++ ")),
  );
  return unified ? "unified" : null;
}

interface Outcome {
  code: number;
  out: string[];
}

function runCli(args: string[]): Outcome {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const arg of args) {
    if (!afterDashDash && arg === "--") {
      afterDashDash = true;
    } else if (!afterDashDash && arg.startsWith("-") && arg !== "-") {
      if (arg.startsWith("--format=")) {
        const value = arg.slice("--format=".length);
        if (format !== null || !FORMAT_NAMES.includes(value)) return { code: 2, out: ["error: usage"] };
        format = value;
      } else if (arg === "--check") {
        if (checkOnly) return { code: 2, out: ["error: usage"] };
        checkOnly = true;
      } else if (arg === "--strict") {
        if (strict) return { code: 2, out: ["error: usage"] };
        strict = true;
      } else {
        return { code: 2, out: ["error: usage"] };
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return { code: 2, out: ["error: usage"] };

  const patchArg = positional.length === 0 ? null : positional[0]!;
  const fromStdin = patchArg === null || patchArg === "-";
  let patchText = "";
  try {
    patchText = readFileSync(fromStdin ? 0 : patchArg!, "utf8");
  } catch {
    if (!fromStdin) return { code: 2, out: ["error: no-patch"] };
  }
  const patchLineList = toPatchLines(patchText);
  const kind = format === null || format === "auto" ? detectFormat(patchLineList) : format;
  if (kind === null) return { code: 2, out: ["error: format"] };

  let edits: EditFn[];
  try {
    if (kind === "json") edits = jsonEdits(patchText, patchLineList);
    else if (kind === "unified") edits = unifiedEdits(patchLineList);
    else if (kind === "search-replace") edits = searchReplaceEdits(patchLineList);
    else edits = v4aEdits(patchLineList);
    if (edits.length === 0) throw new Bail("error: parse 1");
  } catch (e) {
    if (e instanceof Bail) return { code: 2, out: [e.text] };
    throw e;
  }

  const store = new Store();
  const failures: EditFail[] = [];
  for (const edit of edits) {
    const savedStaged = new Map(store.staged);
    const savedMoves = store.moves.length;
    try {
      edit(store, strict);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      store.staged = savedStaged;
      store.moves.length = savedMoves;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    const lines = failures.map((f) => `error: ${f.code} ${f.path}`);
    lines.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out: lines };
  }

  // Report: one line per changed path, in byte order, R for a move pair.
  const finalOf = (p: string): string | null => (store.staged.has(p) ? store.staged.get(p)! : store.baseOf(p));
  const goodMoves = store.moves.filter(
    ([o, n]) => store.baseOf(o) !== null && finalOf(o) === null && store.baseOf(n) === null && finalOf(n) !== null,
  );
  const covered = new Set<string>();
  for (const [o, n] of goodMoves) {
    covered.add(o);
    covered.add(n);
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  for (const [o, n] of goodMoves) rows.push({ key: n, line: `R ${o} -> ${n}` });
  for (const p of store.staged.keys()) {
    if (covered.has(p)) continue;
    const was = store.baseOf(p);
    const now = store.staged.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? "A" : now === null ? "D" : "M"} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, "utf8"), Buffer.from(y.key, "utf8")));

  if (!checkOnly) {
    for (const [p, now] of store.staged) {
      if (store.baseOf(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now, "utf8");
      }
    }
  }
  const summary = `ok: ${rows.length} ${rows.length === 1 ? "file" : "files"}`;
  return { code: 0, out: [...rows.map((r) => r.line), summary] };
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== "") {
  // A trial run: runner.ts drives this same file over the env's checks.
  const mod = await import("./runner.ts");
  await mod.runTrial(envUrl);
} else {
  const outcome = runCli(process.argv.slice(2));
  writeSync(1, outcome.out.map((l) => l + "\n").join(""));
  process.exitCode = outcome.code;
}
