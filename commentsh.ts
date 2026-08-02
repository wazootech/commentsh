/**
 * commentsh — Comment Shell.
 *
 * Run shell commands from inside code comments. commentsh scans text files
 * for comment directives, executes the referenced commands, and either
 * injects their stdout back into the file (`exec:` blocks) or runs them as
 * side effects (`run:` directives).
 *
 * Run it from this repo:
 *
 *   deno run --allow-read --allow-write --allow-run commentsh.ts [OPTIONS] <FILE|DIR>...
 *
 * Or straight from GitHub, without cloning:
 *
 *   deno run --allow-read --allow-write --allow-run \
 *     https://raw.githubusercontent.com/EthanThatOneKid/commentsh/main/commentsh.ts \
 *     [OPTIONS] <FILE|DIR>...
 *
 * @module
 */

export const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Comment syntax detection
// ---------------------------------------------------------------------------

export interface CommentSyntax {
  readonly prefix: string;
  readonly suffix: string;
}

const HTML_COMMENTS: CommentSyntax = { prefix: "<!--", suffix: "-->" };
const HASH_COMMENTS: CommentSyntax = { prefix: "#", suffix: "" };
const SLASH_COMMENTS: CommentSyntax = { prefix: "//", suffix: "" };
const DASH_COMMENTS: CommentSyntax = { prefix: "--", suffix: "" };
const STAR_COMMENTS: CommentSyntax = { prefix: "/*", suffix: "*/" };

/** Comment syntax keyed by file extension (lowercase, with the dot). */
const EXTENSION_SYNTAXES: Record<string, CommentSyntax> = {
  // Markup
  ".md": HTML_COMMENTS,
  ".markdown": HTML_COMMENTS,
  ".html": HTML_COMMENTS,
  ".htm": HTML_COMMENTS,
  ".xml": HTML_COMMENTS,
  ".svg": HTML_COMMENTS,
  // C-family / JS / TS
  ".ts": SLASH_COMMENTS,
  ".tsx": SLASH_COMMENTS,
  ".mts": SLASH_COMMENTS,
  ".cts": SLASH_COMMENTS,
  ".js": SLASH_COMMENTS,
  ".jsx": SLASH_COMMENTS,
  ".mjs": SLASH_COMMENTS,
  ".cjs": SLASH_COMMENTS,
  ".go": SLASH_COMMENTS,
  ".rs": SLASH_COMMENTS,
  ".java": SLASH_COMMENTS,
  ".c": SLASH_COMMENTS,
  ".h": SLASH_COMMENTS,
  ".cc": SLASH_COMMENTS,
  ".cpp": SLASH_COMMENTS,
  ".hpp": SLASH_COMMENTS,
  ".cs": SLASH_COMMENTS,
  ".swift": SLASH_COMMENTS,
  ".kt": SLASH_COMMENTS,
  ".kts": SLASH_COMMENTS,
  ".dart": SLASH_COMMENTS,
  ".zig": SLASH_COMMENTS,
  // Hash comments
  ".py": HASH_COMMENTS,
  ".rb": HASH_COMMENTS,
  ".pl": HASH_COMMENTS,
  ".pm": HASH_COMMENTS,
  ".sh": HASH_COMMENTS,
  ".bash": HASH_COMMENTS,
  ".zsh": HASH_COMMENTS,
  ".fish": HASH_COMMENTS,
  ".yml": HASH_COMMENTS,
  ".yaml": HASH_COMMENTS,
  ".toml": HASH_COMMENTS,
  // Dash comments
  ".sql": DASH_COMMENTS,
  ".lua": DASH_COMMENTS,
  ".hs": DASH_COMMENTS,
  // Block comments
  ".css": STAR_COMMENTS,
  ".scss": STAR_COMMENTS,
  ".sass": STAR_COMMENTS,
  ".less": STAR_COMMENTS,
};

/** Comment syntax keyed by exact filename (files without extensions). */
const FILENAME_SYNTAXES: Record<string, CommentSyntax> = {
  "Dockerfile": HASH_COMMENTS,
  "Containerfile": HASH_COMMENTS,
  "Makefile": HASH_COMMENTS,
  "Gemfile": HASH_COMMENTS,
  "Rakefile": HASH_COMMENTS,
  "justfile": HASH_COMMENTS,
  ".gitignore": HASH_COMMENTS,
  ".gitattributes": HASH_COMMENTS,
  ".env": HASH_COMMENTS,
  ".npmrc": HASH_COMMENTS,
};

/**
 * Resolve the comment syntax for a file path. Falls back to HTML comments
 * (`<!-- -->`) for unknown extensions, which keeps directives invisible in
 * rendered Markdown.
 */
export function syntaxForPath(path: string): CommentSyntax {
  const filename = path.split(/[\\/]/).pop() ?? path;
  if (filename in FILENAME_SYNTAXES) return FILENAME_SYNTAXES[filename];
  const dot = filename.lastIndexOf(".");
  if (dot > 0) {
    const ext = filename.slice(dot).toLowerCase();
    if (ext in EXTENSION_SYNTAXES) return EXTENSION_SYNTAXES[ext];
  }
  return HTML_COMMENTS;
}

// ---------------------------------------------------------------------------
// Directive parsing
// ---------------------------------------------------------------------------

export interface Directive {
  /** `exec` blocks inject stdout; `run` directives execute as side effects. */
  readonly kind: "exec" | "run";
  readonly command: string;
  /** 1-based line number of the directive in the file. */
  readonly line: number;
  /** Character index just past the opening comment. */
  readonly contentStart: number;
  /** Character index where the closing comment begins (exec blocks only). */
  readonly endTagStart: number | undefined;
  /** True when the directive has a closing comment. */
  readonly hasEndTag: boolean;
  /** True when an exec block is missing its closing comment. */
  readonly malformed: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** A raw directive line found while scanning a file. */
interface ParsedToken {
  readonly type: "exec" | "run" | "end";
  readonly command: string | undefined;
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

/**
 * Find every directive in a file's text.
 *
 * Directives are scanned as raw tokens (opening tags, closing tags, and
 * `run:` lines) and then paired up in file order. Anything that appears
 * between an `exec:` opening tag and its `/exec` closing tag is treated as
 * block content, never as a directive in its own right.
 */
export function collectDirectives(text: string, syntax: CommentSyntax): Directive[] {
  const p = escapeRegExp(syntax.prefix);
  const terminator = syntax.suffix ? `\\s*${escapeRegExp(syntax.suffix)}` : `(?=\\r?\\n|$)`;
  const startPattern = new RegExp(
    `^(\\s*)(${p})\\s*(exec|run):\\s*(.+?)${terminator}`,
    "gm",
  );
  const endPattern = new RegExp(`^(\\s*)(${p})\\s*\\/exec${terminator}`, "gm");

  const tokens: ParsedToken[] = [];
  for (const match of text.matchAll(startPattern)) {
    tokens.push({
      type: match[3] === "run" ? "run" : "exec",
      command: match[4].trim(),
      start: match.index,
      end: match.index + match[0].length,
      // The line where the comment itself starts, past any leading whitespace.
      line: lineNumberAt(text, match.index + (match[1]?.length ?? 0)),
    });
  }
  for (const match of text.matchAll(endPattern)) {
    tokens.push({
      type: "end",
      command: undefined,
      start: match.index,
      end: match.index + match[0].length,
      line: lineNumberAt(text, match.index + (match[1]?.length ?? 0)),
    });
  }
  tokens.sort((a, b) => a.start - b.start);

  const directives: Directive[] = [];
  let pendingExec: ParsedToken | undefined;
  for (const token of tokens) {
    if (token.type === "run") {
      if (pendingExec !== undefined) continue; // inside a block: it's content
      directives.push({
        kind: "run",
        command: token.command ?? "",
        line: token.line,
        contentStart: token.end,
        endTagStart: undefined,
        hasEndTag: false,
        malformed: false,
      });
    } else if (token.type === "exec") {
      if (pendingExec !== undefined) {
        // A second opening tag before the closing tag: the first is malformed.
        directives.push({
          kind: "exec",
          command: pendingExec.command ?? "",
          line: pendingExec.line,
          contentStart: pendingExec.end,
          endTagStart: undefined,
          hasEndTag: false,
          malformed: true,
        });
      }
      pendingExec = token;
    } else {
      // Closing tag. Ignore it when it overlaps the opening tag (a command
      // that happens to end in `/exec`, e.g. `<!-- exec: bash /exec -->`).
      if (pendingExec !== undefined && token.start >= pendingExec.end) {
        directives.push({
          kind: "exec",
          command: pendingExec.command ?? "",
          line: pendingExec.line,
          contentStart: pendingExec.end,
          endTagStart: token.start,
          hasEndTag: true,
          malformed: false,
        });
        pendingExec = undefined;
      }
      // Overlapping or stray closing tags are ignored.
    }
  }
  if (pendingExec !== undefined) {
    directives.push({
      kind: "exec",
      command: pendingExec.command ?? "",
      line: pendingExec.line,
      contentStart: pendingExec.end,
      endTagStart: undefined,
      hasEndTag: false,
      malformed: true,
    });
  }
  return directives;
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/** The shell used to run directives, per platform. */
export function shellInvocation(command: string): [string, string[]] {
  if (Deno.build.os === "windows") {
    return ["cmd", ["/d", "/s", "/c", command]];
  }
  return ["sh", ["-c", command]];
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Run a command and capture its output. */
export async function runCommand(command: string): Promise<CommandResult> {
  const [shell, args] = shellInvocation(command);
  const child = new Deno.Command(shell, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout, stderr, code } = await child.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

/** Run a command, streaming its output to the terminal. Returns the exit code. */
export async function runCommandStreamed(command: string): Promise<number> {
  const [shell, args] = shellInvocation(command);
  const child = new Deno.Command(shell, {
    args,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await child.output();
  return code;
}

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

export interface ProcessOptions {
  /** When true, never write files; report whether they would change. */
  readonly check?: boolean;
  /** When true, never write files; return the changes as a unified diff. */
  readonly diff?: boolean;
  /** Override the auto-detected comment prefix. */
  readonly prefixOverride?: string;
  /** Override the auto-detected comment suffix. */
  readonly suffixOverride?: string;
}

export interface ProcessResult {
  readonly path: string;
  readonly changed: boolean;
  readonly directives: number;
  /** Set when the file was skipped (binary) or failed to process. */
  readonly skipped: boolean;
  /** Human-readable error, if any. */
  readonly error: string | undefined;
  /** Non-zero when a directive's command failed. */
  readonly exitCode: number;
  /** Unified diff of the changes (only when the `diff` option is set). */
  readonly diff: string | undefined;
}

/**
 * Process one file: execute its directives and, unless `--check` is set,
 * write the file back when an exec block's injected content changed.
 */
export async function processFile(
  path: string,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const { check = false, diff = false, prefixOverride, suffixOverride } = options;
  const text = await Deno.readTextFile(path);

  // Binary files produce replacement characters and NUL bytes; skip them.
  if (text.includes("\u0000")) {
    return {
      path,
      changed: false,
      directives: 0,
      skipped: true,
      error: undefined,
      exitCode: 0,
      diff: undefined,
    };
  }

  const auto = syntaxForPath(path);
  const syntax: CommentSyntax = {
    prefix: prefixOverride ?? auto.prefix,
    suffix: suffixOverride ?? auto.suffix,
  };

  const directives = collectDirectives(text, syntax);

  // Execute directives in order and collect the captured outputs.
  const outputs: string[] = [];
  let error: string | undefined;
  let exitCode = 0;
  for (const directive of directives) {
    if (directive.malformed) {
      const closing = syntax.suffix
        ? `${syntax.prefix} /exec ${syntax.suffix}`
        : `${syntax.prefix} /exec`;
      error = `exec block at line ${directive.line} has no closing \`${closing}\` comment`;
      exitCode = 1;
      break;
    }
    if (directive.kind === "run") {
      const code = await runCommandStreamed(directive.command);
      if (code !== 0) {
        error = `run directive at line ${directive.line} failed (exit code ${code}): ` +
          directive.command;
        exitCode = code || 1;
        break;
      }
      outputs.push("");
    } else {
      const result = await runCommand(directive.command);
      if (result.code !== 0) {
        const detail = result.stderr.trimEnd();
        error = `exec block at line ${directive.line} failed (exit code ${result.code}): ` +
          directive.command + (detail ? `\n${detail}` : "");
        exitCode = result.code || 1;
        break;
      }
      outputs.push(result.stdout.trimEnd());
    }
  }

  if (error !== undefined) {
    return {
      path,
      changed: false,
      directives: directives.length,
      skipped: false,
      error,
      exitCode,
      diff: undefined,
    };
  }

  // Apply exec injections right-to-left so character indices stay valid.
  // The blank lines around the current content are preserved so that
  // external formatters (deno fmt, prettier) cannot fight commentsh over
  // spacing — only the actual output lines are replaced.
  let updated = text;
  for (let i = directives.length - 1; i >= 0; i--) {
    const directive = directives[i];
    if (directive.kind !== "exec" || directive.endTagStart === undefined) {
      continue;
    }
    // Defensive: never inject when the tags overlap (should not happen).
    if (directive.endTagStart < directive.contentStart) continue;
    const content = updated.slice(directive.contentStart, directive.endTagStart);
    const layout = /^(\s*)([\s\S]*?)(\s*)$/.exec(content) ?? ["", "", "", ""];
    const injected = (layout[1] ?? "") + outputs[i] + (layout[3] ?? "");
    updated = updated.slice(0, directive.contentStart) + injected +
      updated.slice(directive.endTagStart);
  }

  const changed = updated !== text;
  const diffText = diff && changed ? unifiedDiff(text, updated, path) : undefined;
  if (changed && !check && !diff) {
    await Deno.writeTextFile(path, updated);
  }
  return {
    path,
    changed,
    directives: directives.length,
    skipped: false,
    error: undefined,
    exitCode: 0,
    diff: diffText,
  };
}

// ---------------------------------------------------------------------------
// Unified diff rendering
// ---------------------------------------------------------------------------

type DiffOp = { readonly kind: "eq" | "del" | "ins"; readonly text: string };

/** Split into lines, dropping the phantom line from a trailing newline. */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Compute a line-based edit script between two texts using LCS dynamic
 * programming. Falls back to a coarse prefix/suffix diff on very large
 * inputs so memory stays bounded.
 */
function computeDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return coarseDiff(a, b);
  if (n === 0) return b.map((text) => ({ kind: "ins", text }));
  if (m === 0) return a.map((text) => ({ kind: "del", text }));

  // LCS lengths in a flat matrix, then backtrack into an edit script.
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ kind: "del", text: a[i] });
      i++;
    } else {
      ops.push({ kind: "ins", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] });
  while (j < m) ops.push({ kind: "ins", text: b[j++] });
  return ops;
}

function coarseDiff(a: string[], b: string[]): DiffOp[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix && suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const ops: DiffOp[] = [];
  for (let i = prefix; i < a.length - suffix; i++) {
    ops.push({ kind: "del", text: a[i] });
  }
  for (let i = prefix; i < b.length - suffix; i++) {
    ops.push({ kind: "ins", text: b[i] });
  }
  return ops;
}

interface DiffHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly ops: DiffOp[];
}

/** Group an edit script into hunks with surrounding context lines. */
function buildHunks(ops: DiffOp[], context = 3): DiffHunk[] {
  const changes: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind !== "eq") changes.push(i);
  }
  if (changes.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  let lo = changes[0];
  let hi = changes[0];
  for (let k = 1; k < changes.length; k++) {
    const idx = changes[k];
    if (idx - hi <= 2 * context + 1) {
      hi = idx;
    } else {
      ranges.push([lo, hi]);
      lo = idx;
      hi = idx;
    }
  }
  ranges.push([lo, hi]);

  const hunks: DiffHunk[] = [];
  for (const [start, end] of ranges) {
    const from = Math.max(0, start - context);
    const to = Math.min(ops.length - 1, end + context);
    const sub = ops.slice(from, to + 1);
    let oldCount = 0;
    let newCount = 0;
    for (const op of sub) {
      if (op.kind !== "ins") oldCount++;
      if (op.kind !== "del") newCount++;
    }
    let oldStart = 1;
    let newStart = 1;
    for (let k = 0; k < from; k++) {
      if (ops[k].kind !== "ins") oldStart++;
      if (ops[k].kind !== "del") newStart++;
    }
    if (oldCount === 0) oldStart = Math.max(0, oldStart - 1);
    if (newCount === 0) newStart = Math.max(0, newStart - 1);
    hunks.push({ oldStart, oldCount, newStart, newCount, ops: sub });
  }
  return hunks;
}

/** Render a standard unified diff for a single file (git-style header). */
export function unifiedDiff(original: string, updated: string, path: string): string {
  const ops = computeDiff(splitLines(original), splitLines(updated));
  const hunks = buildHunks(ops);
  if (hunks.length === 0) return "";
  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
  ];
  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const op of hunk.ops) {
      const marker = op.kind === "eq" ? " " : op.kind === "del" ? "-" : "+";
      lines.push(`${marker}${op.text}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Directory walking
// ---------------------------------------------------------------------------

/** Directories that are never descended into when walking a path. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".deno",
  ".cache",
  ".venv",
  "venv",
  "env",
  "node_modules",
  "bower_components",
  "vendor",
  "target",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "out",
]);

async function* walkDirectory(directory: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      yield* walkDirectory(path);
    } else if (entry.isFile) {
      yield path;
    }
  }
}

/** Expand a list of file and directory paths into a flat list of files. */
export async function collectFiles(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const path of paths) {
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(path);
    } catch (err) {
      throw new Error(
        `cannot access ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (info.isFile) {
      files.push(path);
    } else if (info.isDirectory) {
      for await (const entry of walkDirectory(path)) {
        files.push(entry);
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliOptions {
  check: boolean;
  diff: boolean;
  watch: boolean;
  prefix: string | undefined;
  suffix: string | undefined;
  files: string[];
}

export type CliAction =
  | { readonly kind: "run"; readonly options: CliOptions }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "error"; readonly message: string };

/** Parse command-line arguments. */
export function parseArgs(args: string[]): CliAction {
  const options: CliOptions = {
    check: false,
    diff: false,
    watch: false,
    prefix: undefined,
    suffix: undefined,
    files: [],
  };
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positionalOnly) {
      options.files.push(arg);
      continue;
    }
    switch (arg) {
      case "--":
        positionalOnly = true;
        break;
      case "-h":
      case "--help":
        return { kind: "help" };
      case "-V":
      case "--version":
        return { kind: "version" };
      case "--check":
        options.check = true;
        break;
      case "--diff":
        options.diff = true;
        break;
      case "--watch":
        options.watch = true;
        break;
      case "--prefix":
      case "--suffix": {
        const value = args[++i];
        if (value === undefined) {
          return { kind: "error", message: `missing value for ${arg}` };
        }
        if (arg === "--prefix") options.prefix = value;
        else options.suffix = value;
        break;
      }
      default:
        if (arg.startsWith("--prefix=")) {
          options.prefix = arg.slice("--prefix=".length);
        } else if (arg.startsWith("--suffix=")) {
          options.suffix = arg.slice("--suffix=".length);
        } else if (arg.startsWith("-") && arg !== "-") {
          return { kind: "error", message: `unknown option: ${arg}` };
        } else {
          options.files.push(arg);
        }
    }
  }
  if (options.watch && options.check) {
    return { kind: "error", message: "cannot combine --watch with --check" };
  }
  if (options.files.length === 0) {
    return { kind: "error", message: "no files or directories given" };
  }
  return { kind: "run", options };
}

/** The help text shown by `--help`. */
export function helpText(): string {
  return `commentsh ${VERSION} — Comment Shell
Run shell commands from inside code comments.

USAGE:
  commentsh [OPTIONS] <FILE|DIR>...

DESCRIPTION:
  commentsh scans text files for comment directives and executes the
  commands they reference. Comment syntax is auto-detected from each
  file's extension (or filename) and can be overridden with --prefix and
  --suffix. Directives must appear at the start of a line.

  Two kinds of directives are supported:

  exec   A block form. An opening comment names a command; the command's
         stdout is injected between the opening and closing comments.
         Use it to keep documentation in sync with live command output.

  run    A one-line form. The command runs as a side effect (like
         go:generate) and the file itself is left untouched.

  Commands run through the platform shell — sh -c on Unix and macOS,
  cmd /c on Windows.

OPTIONS:
      --check            Do not write files. Exit with code 1 if any file
                         would change. Use in CI to catch stale docs.
      --diff             Do not write files. Print the changes as a unified
                         diff instead.
      --watch            Reprocess files whenever they change on disk.
      --prefix <string>  Override the comment prefix (e.g. "--" for SQL).
      --suffix <string>  Override the comment suffix (e.g. "-->" for HTML).
                         Pass an empty string for line comments.
  -h, --help             Print this help message and exit.
  -V, --version          Print the version number and exit.

EXIT CODES:
  0  Success. With --check, every file is up to date.
  1  A command failed, a directive is malformed, or (with --check) a file
     is out of date.
  2  Invalid command-line usage.

EXAMPLES:
  commentsh README.md
  commentsh src docs
  commentsh --check .          # fail CI if any docs are stale
  commentsh --diff README.md   # preview changes
  commentsh --watch README.md  # live-update while editing
  commentsh --prefix -- --suffix "" schema.sql

  Run it without cloning, straight from the repo:

  deno run --allow-read --allow-write --allow-run \\
    https://raw.githubusercontent.com/EthanThatOneKid/commentsh/main/commentsh.ts \\
    README.md

See https://github.com/EthanThatOneKid/commentsh for more information.`;
}

/** CLI entry point. */
export async function main(): Promise<void> {
  const action = parseArgs(Deno.args);
  switch (action.kind) {
    case "help":
      console.log(helpText());
      Deno.exit(0);
      break;
    case "version":
      console.log(`commentsh ${VERSION}`);
      Deno.exit(0);
      break;
    case "error":
      console.error(`commentsh: ${action.message}`);
      console.error('Run "commentsh --help" for usage.');
      Deno.exit(2);
      break;
    case "run":
      await runCli(action.options);
      break;
  }
}

async function runCli(options: CliOptions): Promise<void> {
  if (options.watch) {
    await runWatch(options);
    return;
  }

  let files: string[];
  try {
    files = await collectFiles(options.files);
  } catch (err) {
    console.error(`commentsh: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }

  const { changed, errors, firstExitCode } = await processFileList(files, options);

  if (options.diff) {
    // The diffs themselves are the output; keep stdout clean for piping.
    if (errors > 0) console.error(`commentsh: ${errors} error(s)`);
    else if (changed > 0) console.error(`commentsh: ${changed} file(s) would change`);
    let exitCode = firstExitCode;
    if (options.check && changed > 0 && exitCode === 0) exitCode = 1;
    Deno.exit(exitCode);
  }

  if (options.check) {
    if (errors === 0 && changed === 0) {
      console.log(`commentsh: all ${files.length} file(s) up to date`);
    } else {
      console.error(
        `commentsh: ${errors} error(s), ${changed} file(s) out of date`,
      );
    }
  } else {
    console.log(
      `commentsh: ${files.length} file(s) processed, ${changed} updated, ` +
        `${errors} error(s)`,
    );
  }

  let exitCode = firstExitCode;
  if (options.check && changed > 0 && exitCode === 0) exitCode = 1;
  Deno.exit(exitCode);
}

interface FileListSummary {
  readonly changed: number;
  readonly errors: number;
  readonly firstExitCode: number;
}

/** Process a list of files, printing per-file results; returns counts. */
async function processFileList(
  files: string[],
  options: CliOptions,
): Promise<FileListSummary> {
  let changed = 0;
  let errors = 0;
  let firstExitCode = 0;
  for (const file of files) {
    let result: ProcessResult;
    try {
      result = await processFile(file, {
        check: options.check,
        diff: options.diff,
        prefixOverride: options.prefix,
        suffixOverride: options.suffix,
      });
    } catch (err) {
      console.error(
        `commentsh: ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      errors++;
      firstExitCode ||= 1;
      continue;
    }
    if (result.skipped) continue;
    if (result.error !== undefined) {
      console.error(`commentsh: ${file}: ${result.error}`);
      errors++;
      firstExitCode ||= result.exitCode || 1;
      continue;
    }
    if (result.changed) {
      changed++;
      if (result.diff !== undefined) {
        console.log(result.diff);
        console.log("");
      } else if (options.check) {
        console.log(`out of date: ${file}`);
      } else {
        console.log(`updated: ${file}`);
      }
    }
  }
  return { changed, errors, firstExitCode };
}

// ---------------------------------------------------------------------------
// Watch mode
// ---------------------------------------------------------------------------

/** Debounce a function: only the last call within `ms` milliseconds runs. */
export function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  };
}

/** Drop paths that live inside a skipped directory (node_modules, .git, …). */
export function filterWatchPaths(paths: string[]): string[] {
  return paths.filter((path) => {
    const segments = path.split(/[\\/]/);
    return !segments.some((segment) => segment !== "" && SKIPPED_DIRECTORIES.has(segment));
  });
}

/**
 * Reprocess files whenever the watched paths change. Runs an initial pass,
 * then reacts to filesystem events until the process is interrupted.
 */
export async function runWatch(options: CliOptions): Promise<void> {
  const initial = await collectFiles(options.files).catch((err: unknown) => {
    console.error(`commentsh: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  });
  await processFileList(initial, options);
  console.log(
    `commentsh: watching ${options.files.join(", ")} — press Ctrl-C to stop`,
  );

  const watcher = Deno.watchFs(options.files, { recursive: true });
  const pending = new Set<string>();
  let processing = false;
  const flush = debounce(async () => {
    // Skip while a pass is in flight; the finishing pass re-schedules so
    // edits made during processing are not dropped.
    if (processing) return;
    processing = true;
    const files: string[] = [];
    for (const candidate of filterWatchPaths([...pending])) {
      try {
        const info = await Deno.stat(candidate);
        if (info.isFile) files.push(candidate);
      } catch {
        // Path vanished (deleted or moved); nothing to process.
      }
    }
    pending.clear();
    if (files.length > 0) {
      try {
        await processFileList(files, options);
      } catch (err) {
        console.error(`commentsh: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    processing = false;
    if (pending.size > 0) flush();
  }, 150);
  for await (const event of watcher) {
    for (const path of event.paths) pending.add(path);
    flush();
  }
}

if (import.meta.main) {
  await main();
}
