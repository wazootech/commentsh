/**
 * commentsh — Comment Shell. Runs shell commands from code comments.
 * `cmd:` blocks inject command stdout between the tag and its `/cmd` closer;
 * `cmd!:` lines run one-liners as side effects. Zero imports; run from any
 * URL or checkout.
 * @module
 */

export const VERSION = "0.2.0";

// ---------------------------------------------------------------------------
// Comment syntax detection
// ---------------------------------------------------------------------------

export interface CommentSyntax {
  readonly prefix: string;
  readonly suffix: string;
}

const HTML: CommentSyntax = { prefix: "<!--", suffix: "-->" };
const HASH: CommentSyntax = { prefix: "#", suffix: "" };
const SLASH: CommentSyntax = { prefix: "//", suffix: "" };
const DASH: CommentSyntax = { prefix: "--", suffix: "" };
const STAR: CommentSyntax = { prefix: "/*", suffix: "*/" };

const EXT: Record<string, CommentSyntax> = {
  ".md": HTML,
  ".markdown": HTML,
  ".html": HTML,
  ".htm": HTML,
  ".xml": HTML,
  ".svg": HTML,
  ".ts": SLASH,
  ".tsx": SLASH,
  ".mts": SLASH,
  ".cts": SLASH,
  ".js": SLASH,
  ".jsx": SLASH,
  ".mjs": SLASH,
  ".cjs": SLASH,
  ".go": SLASH,
  ".rs": SLASH,
  ".java": SLASH,
  ".c": SLASH,
  ".h": SLASH,
  ".cc": SLASH,
  ".cpp": SLASH,
  ".hpp": SLASH,
  ".cs": SLASH,
  ".swift": SLASH,
  ".kt": SLASH,
  ".kts": SLASH,
  ".dart": SLASH,
  ".zig": SLASH,
  ".py": HASH,
  ".rb": HASH,
  ".pl": HASH,
  ".pm": HASH,
  ".sh": HASH,
  ".bash": HASH,
  ".zsh": HASH,
  ".fish": HASH,
  ".yml": HASH,
  ".yaml": HASH,
  ".toml": HASH,
  ".sql": DASH,
  ".lua": DASH,
  ".hs": DASH,
  ".css": STAR,
  ".scss": STAR,
  ".sass": STAR,
  ".less": STAR,
};

const NAME: Record<string, CommentSyntax> = {
  "Dockerfile": HASH,
  "Containerfile": HASH,
  "Makefile": HASH,
  "Gemfile": HASH,
  "Rakefile": HASH,
  "justfile": HASH,
  ".gitignore": HASH,
  ".gitattributes": HASH,
  ".env": HASH,
  ".npmrc": HASH,
};

/** Comment syntax for a path; unknown extensions fall back to HTML. */
export function syntaxForPath(path: string): CommentSyntax {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (name in NAME) return NAME[name];
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const ext = name.slice(dot).toLowerCase();
    if (ext in EXT) return EXT[ext];
  }
  return HTML;
}

// ---------------------------------------------------------------------------
// Directive parsing (hand-written tokenizer, no regex scanning)
// ---------------------------------------------------------------------------

export interface Directive {
  /** `inject` blocks write stdout into the file; `run` directives are `cmd!` side effects. */
  readonly kind: "inject" | "run";
  readonly command: string;
  readonly line: number;
  readonly contentStart: number;
  readonly endTagStart: number | undefined;
  readonly hasEndTag: boolean;
  readonly malformed: boolean;
}

interface Token {
  readonly type: "inject" | "run" | "end";
  readonly command: string | undefined;
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

const WS = /[\t\r\f\v ]/;

/** True when a terminator follows at `from`: the HTML suffix or end of line. */
function hasTerminator(line: string, from: number, suffix: string): boolean {
  if (suffix === "") return from === line.length;
  let j = from;
  while (j < line.length && WS.test(line[j])) j++;
  return line.startsWith(suffix, j);
}

/** Command text after a directive's colon, up to the suffix / end of line. */
function scanCommand(
  line: string,
  from: number,
  suffix: string,
): { command: string; commentEnd: number } | undefined {
  let i = from;
  while (i < line.length && WS.test(line[i])) i++;
  if (suffix === "") {
    let end = line.length;
    while (end > i && WS.test(line[end - 1])) end--;
    return { command: line.slice(i, end), commentEnd: line.length };
  }
  const end = line.indexOf(suffix, i);
  if (end === -1) return undefined;
  let commandEnd = end;
  while (commandEnd > i && WS.test(line[commandEnd - 1])) commandEnd--;
  return { command: line.slice(i, commandEnd), commentEnd: end + suffix.length };
}

/**
 * Scan one line for a directive token. Directives start a line (after
 * whitespace) with the comment prefix, then `cmd [!] :` or `/cmd`.
 */
function scanLine(
  line: string,
  lineStart: number,
  lineNo: number,
  syntax: CommentSyntax,
): Token | undefined {
  const { prefix, suffix } = syntax;
  let i = 0;
  while (i < line.length && WS.test(line[i])) i++;
  if (!line.startsWith(prefix, i)) return undefined;
  i += prefix.length;
  while (i < line.length && WS.test(line[i])) i++;

  if (line.startsWith("/cmd", i)) {
    const after = i + 4;
    if (hasTerminator(line, after, suffix)) {
      return {
        type: "end",
        command: undefined,
        start: lineStart,
        end: lineStart + after,
        line: lineNo,
      };
    }
    return undefined;
  }
  if (line.startsWith("cmd", i)) {
    let k = i + 3;
    const bang = line[k] === "!";
    if (bang) k++;
    if (line[k] !== ":") return undefined;
    const cmd = scanCommand(line, k + 1, suffix);
    if (cmd === undefined) return undefined;
    return {
      type: bang ? "run" : "inject",
      command: cmd.command,
      start: lineStart,
      end: lineStart + cmd.commentEnd,
      line: lineNo,
    };
  }
  return undefined;
}

/** Every directive token in a file, in line order. */
function scanTokens(text: string, syntax: CommentSyntax): Token[] {
  const tokens: Token[] = [];
  let lineStart = 0;
  let lineNo = 1;
  while (lineStart <= text.length) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const token = scanLine(line, lineStart, lineNo, syntax);
    if (token !== undefined) tokens.push(token);
    if (nl === -1) break;
    lineStart = nl + 1;
    lineNo++;
  }
  return tokens;
}

/**
 * Find every directive in a file. Tokens are paired in file order; content
 * between a `cmd:` opening tag and its `/cmd` closer is never a directive.
 */
export function collectDirectives(text: string, syntax: CommentSyntax): Directive[] {
  const tokens = scanTokens(text, syntax);
  const out: Directive[] = [];
  let open: Token | undefined;
  for (const t of tokens) {
    if (t.type === "run") {
      if (open !== undefined) continue; // inside a block: content
      out.push({
        kind: "run",
        command: t.command ?? "",
        line: t.line,
        contentStart: t.end,
        endTagStart: undefined,
        hasEndTag: false,
        malformed: false,
      });
    } else if (t.type === "inject") {
      if (open !== undefined) {
        // Second opening before a closer: the first is malformed.
        out.push({
          kind: "inject",
          command: open.command ?? "",
          line: open.line,
          contentStart: open.end,
          endTagStart: undefined,
          hasEndTag: false,
          malformed: true,
        });
      }
      open = t;
    } else if (open !== undefined && t.start >= open.end) {
      out.push({
        kind: "inject",
        command: open.command ?? "",
        line: open.line,
        contentStart: open.end,
        endTagStart: t.start,
        hasEndTag: true,
        malformed: false,
      });
      open = undefined;
    }
    // Stray or overlapping closing tags are ignored.
  }
  if (open !== undefined) {
    out.push({
      kind: "inject",
      command: open.command ?? "",
      line: open.line,
      contentStart: open.end,
      endTagStart: undefined,
      hasEndTag: false,
      malformed: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

export function shellInvocation(command: string): [string, string[]] {
  return Deno.build.os === "windows"
    ? ["cmd", ["/d", "/s", "/c", command]]
    : ["sh", ["-c", command]];
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Run a command, capturing stdout/stderr. */
export async function runCommand(command: string): Promise<CommandResult> {
  const [shell, args] = shellInvocation(command);
  const { stdout, stderr, code } = await new Deno.Command(shell, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

/** Run a command, streaming output to the terminal. */
export async function runCommandStreamed(command: string): Promise<number> {
  const [shell, args] = shellInvocation(command);
  return (await new Deno.Command(shell, { args, stdout: "inherit", stderr: "inherit" }).output())
    .code;
}

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

export interface ProcessOptions {
  readonly check?: boolean;
  readonly diff?: boolean;
  readonly prefixOverride?: string;
  readonly suffixOverride?: string;
}

export interface ProcessResult {
  readonly path: string;
  readonly changed: boolean;
  readonly directives: number;
  readonly skipped: boolean;
  readonly error: string | undefined;
  readonly exitCode: number;
  readonly diff: string | undefined;
}

/** Execute a file's directives; write back when an inject block changed. */
export async function processFile(
  path: string,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const { check = false, diff = false, prefixOverride, suffixOverride } = options;
  const text = await Deno.readTextFile(path);
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

  const outputs: string[] = [];
  let error: string | undefined;
  let exitCode = 0;
  for (const d of directives) {
    if (d.malformed) {
      const closing = syntax.suffix
        ? `${syntax.prefix} /cmd ${syntax.suffix}`
        : `${syntax.prefix} /cmd`;
      error = `cmd block at line ${d.line} has no closing \`${closing}\` comment`;
      exitCode = 1;
      break;
    }
    if (d.kind === "run") {
      const code = await runCommandStreamed(d.command);
      if (code !== 0) {
        error = `cmd! directive at line ${d.line} failed (exit code ${code}): ${d.command}`;
        exitCode = code || 1;
        break;
      }
      outputs.push("");
    } else {
      const result = await runCommand(d.command);
      if (result.code !== 0) {
        const detail = result.stderr.trimEnd();
        error = `cmd block at line ${d.line} failed (exit code ${result.code}): ${d.command}` +
          (detail ? `\n${detail}` : "");
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

  // Apply inject blocks right-to-left so indices stay valid. The blank lines
  // around the old content are kept so formatters never fight commentsh.
  let updated = text;
  for (let i = directives.length - 1; i >= 0; i--) {
    const d = directives[i];
    if (d.kind !== "inject" || d.endTagStart === undefined || d.endTagStart < d.contentStart) {
      continue;
    }
    const content = updated.slice(d.contentStart, d.endTagStart);
    const layout = /^(\s*)([\s\S]*?)(\s*)$/.exec(content) ?? ["", "", "", ""];
    const injected = (layout[1] ?? "") + outputs[i] + (layout[3] ?? "");
    updated = updated.slice(0, d.contentStart) + injected + updated.slice(d.endTagStart);
  }

  const changed = updated !== text;
  const diffText = diff && changed ? unifiedDiff(text, updated, path) : undefined;
  if (changed && !check && !diff) await Deno.writeTextFile(path, updated);
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

type DiffOp = { kind: "eq" | "del" | "ins"; text: string };

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line edit script via LCS; coarse prefix/suffix fallback on huge inputs. */
function computeDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return coarseDiff(a, b);
  if (n === 0) return b.map((text) => ({ kind: "ins", text }));
  if (m === 0) return a.map((text) => ({ kind: "del", text }));
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
  ) suffix++;
  const ops: DiffOp[] = [];
  for (let i = prefix; i < a.length - suffix; i++) ops.push({ kind: "del", text: a[i] });
  for (let i = prefix; i < b.length - suffix; i++) ops.push({ kind: "ins", text: b[i] });
  return ops;
}

/** Render a git-style unified diff for one file. */
export function unifiedDiff(original: string, updated: string, path: string): string {
  const ops = computeDiff(splitLines(original), splitLines(updated));
  const changes: number[] = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].kind !== "eq") changes.push(i);
  if (changes.length === 0) return "";

  const context = 3;
  const ranges: Array<[number, number]> = [];
  let lo = changes[0];
  let hi = changes[0];
  for (let k = 1; k < changes.length; k++) {
    const idx = changes[k];
    if (idx - hi <= 2 * context + 1) hi = idx;
    else {
      ranges.push([lo, hi]);
      lo = idx;
      hi = idx;
    }
  }
  ranges.push([lo, hi]);

  const lines: string[] = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
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
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of sub) {
      lines.push(`${op.kind === "eq" ? " " : op.kind === "del" ? "-" : "+"}${op.text}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Directory walking
// ---------------------------------------------------------------------------

const SKIPPED = new Set([
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

async function* walkDirectory(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (!SKIPPED.has(entry.name)) yield* walkDirectory(path);
    } else if (entry.isFile) {
      yield path;
    }
  }
}

/** Expand files and directories into a flat file list. */
export async function collectFiles(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const path of paths) {
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(path);
    } catch (err) {
      throw new Error(`cannot access ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (info.isFile) files.push(path);
    else if (info.isDirectory) {
      for await (const entry of walkDirectory(path)) files.push(entry);
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
        if (value === undefined) return { kind: "error", message: `missing value for ${arg}` };
        if (arg === "--prefix") options.prefix = value;
        else options.suffix = value;
        break;
      }
      default:
        if (arg.startsWith("--prefix=")) options.prefix = arg.slice("--prefix=".length);
        else if (arg.startsWith("--suffix=")) options.suffix = arg.slice("--suffix=".length);
        else if (arg.startsWith("-") && arg !== "-") {
          return { kind: "error", message: `unknown option: ${arg}` };
        } else options.files.push(arg);
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

  One directive, two forms:

  cmd    A block form. An opening comment names a command; the command's
         stdout is injected between the opening and closing comments.
         Use it to keep documentation in sync with live command output.

  cmd!   A one-line form. The command runs as a side effect (like
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
    if (errors > 0) console.error(`commentsh: ${errors} error(s)`);
    else if (changed > 0) console.error(`commentsh: ${changed} file(s) would change`);
    let exitCode = firstExitCode;
    if (options.check && changed > 0 && exitCode === 0) exitCode = 1;
    Deno.exit(exitCode);
  }

  if (options.check) {
    if (errors === 0 && changed === 0) {
      console.log(`commentsh: all ${files.length} file(s) up to date`);
    } else console.error(`commentsh: ${errors} error(s), ${changed} file(s) out of date`);
  } else {
    console.log(
      `commentsh: ${files.length} file(s) processed, ${changed} updated, ${errors} error(s)`,
    );
  }

  let exitCode = firstExitCode;
  if (options.check && changed > 0 && exitCode === 0) exitCode = 1;
  Deno.exit(exitCode);
}

async function processFileList(files: string[], options: CliOptions) {
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
      console.error(`commentsh: ${file}: ${err instanceof Error ? err.message : String(err)}`);
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

/** Drop paths inside skipped directories (node_modules, .git, …). */
export function filterWatchPaths(paths: string[]): string[] {
  return paths.filter((path) =>
    !path.split(/[\\/]/).some((segment) => segment !== "" && SKIPPED.has(segment))
  );
}

/** Reprocess files on change; runs an initial pass, then reacts to fs events. */
export async function runWatch(options: CliOptions): Promise<void> {
  const initial = await collectFiles(options.files).catch((err: unknown) => {
    console.error(`commentsh: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  });
  await processFileList(initial, options);
  console.log(`commentsh: watching ${options.files.join(", ")} — press Ctrl-C to stop`);

  const watcher = Deno.watchFs(options.files, { recursive: true });
  const pending = new Set<string>();
  let processing = false;
  const flush = debounce(async () => {
    if (processing) return;
    processing = true;
    const files: string[] = [];
    for (const candidate of filterWatchPaths([...pending])) {
      try {
        const info = await Deno.stat(candidate);
        if (info.isFile) files.push(candidate);
      } catch {
        // Path vanished; nothing to process.
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
