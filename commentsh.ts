/**
 * commentsh — Comment Shell. Runs shell commands from code comments.
 * `cmd:` blocks inject command stdout between the tag and its `/cmd` closer;
 * `cmd!:` lines run one-liners as side effects. Uses @std/fs for file walking
 * and @std/cli for argument parsing; run from any URL or checkout.
 * @module
 */
import { parseArgs as parseArgsStd } from "@std/cli/parse-args";
import { walk } from "@std/fs/walk";

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
      malformed: true,
    });
  }
  return out;
}

/** Neutralized comment open per syntax, kept readable. */
const ESCAPED_PREFIX: Record<string, string> = {
  "<!--": "&lt;!--",
  "#": "##",
  "//": "///",
  "--": "---",
  "/*": "/**",
};

/**
 * Escape directive-lookalike lines in command output so stdout can never forge
 * an opening or closing tag. A line the tokenizer would parse as a directive
 * gets its comment open neutralized; escaped lines no longer tokenize, so
 * re-running is stable.
 */
export function escapeOutput(output: string, syntax: CommentSyntax): string {
  if (!output.includes(syntax.prefix)) return output;
  const esc = ESCAPED_PREFIX[syntax.prefix] ?? syntax.prefix + syntax.prefix.slice(-1);
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (scanLine(bare, 0, 1, syntax) !== undefined) {
      const at = line.indexOf(syntax.prefix);
      lines[i] = line.slice(0, at) + esc + line.slice(at + syntax.prefix.length);
    }
  }
  return lines.join("\n");
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

/** Run a command, capturing output, or streaming it to the terminal. */
// stream mode discards stdout/stderr (empty strings) and returns only the exit code.
export async function runCommand(command: string, stream = false): Promise<CommandResult> {
  const [shell, args] = shellInvocation(command);
  const out = await new Deno.Command(shell, {
    args,
    stdout: stream ? "inherit" : "piped",
    stderr: stream ? "inherit" : "piped",
  }).output();
  if (stream) return { stdout: "", stderr: "", code: out.code };
  return {
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    code: out.code,
  };
}

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

export interface ProcessOptions {
  readonly check?: boolean;
  readonly diff?: boolean;
}

/** One stale inject block: its 1-based line number and opening tag. */
export interface StaleBlock {
  readonly line: number;
  readonly tag: string;
}

export interface ProcessResult {
  readonly path: string;
  readonly changed: boolean;
  readonly directives: number;
  readonly skipped: boolean;
  readonly error: string | undefined;
  readonly exitCode: number;
  readonly diff: string | undefined;
  readonly staleBlocks?: StaleBlock[];
}

/** Execute a file's directives; write back when an inject block changed. */
export async function processFile(
  path: string,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const { check = false, diff = false } = options;
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
      staleBlocks: [],
    };
  }

  const syntax = syntaxForPath(path);
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
      const code = (await runCommand(d.command, true)).code;
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
      staleBlocks: [],
    };
  }

  // Apply inject blocks right-to-left so indices stay valid. The blank lines
  // around the old content are kept so formatters never fight commentsh.
  const diffBlocks: string[] = [];
  const staleBlocks: StaleBlock[] = [];
  let updated = text;
  for (let i = directives.length - 1; i >= 0; i--) {
    const d = directives[i];
    if (d.kind !== "inject" || d.endTagStart === undefined || d.endTagStart < d.contentStart) {
      continue;
    }
    const content = updated.slice(d.contentStart, d.endTagStart);
    const layout = /^(\s*)([\s\S]*?)(\s*)$/.exec(content) ?? ["", "", "", ""];
    const escaped = escapeOutput(outputs[i], syntax);
    const injected = (layout[1] ?? "") + escaped + (layout[3] ?? "");
    if (injected !== content) {
      const tagStart = text.lastIndexOf("\n", d.contentStart - 1) + 1;
      const tag = text.slice(tagStart, d.contentStart).trim();
      diffBlocks.push(
        renderBlockDiff(d, tag, (layout[2] ?? "").split("\n"), escaped.split("\n")),
      );
      staleBlocks.push({ line: d.line, tag });
    }
    updated = updated.slice(0, d.contentStart) + injected + updated.slice(d.endTagStart);
  }

  const changed = updated !== text;
  const diffText = diff && diffBlocks.length > 0
    ? `${path}: ${diffBlocks.length} block(s) would change\n\n${diffBlocks.reverse().join("\n\n")}`
    : undefined;
  if (changed && !check && !diff) await Deno.writeTextFile(path, updated);
  return {
    path,
    changed,
    directives: directives.length,
    skipped: false,
    error: undefined,
    exitCode: 0,
    diff: diffText,
    staleBlocks: staleBlocks.reverse(),
  };
}

// ---------------------------------------------------------------------------
// Block diff rendering
// ---------------------------------------------------------------------------

/** Header for one inject block: its line number and opening tag. */
function blockHeader(line: number, tag: string): string {
  return `line ${line} (${tag})`;
}

/** Render one inject block's change: removed lines (-) then added lines (+). */
function renderBlockDiff(
  directive: Directive,
  tag: string,
  oldLines: string[],
  newLines: string[],
): string {
  const lines = [blockHeader(directive.line, tag)];
  for (const line of oldLines) lines.push(`  - ${line.replace(/\r/g, "")}`);
  for (const line of newLines) lines.push(`  + ${line.replace(/\r/g, "")}`);
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

/** Skip regex for @std/fs/walk: matches a SKIPPED name at the start or
 * end of a path segment, so nested vendor folders AND top-level ones
 * under a relative root like `.` are pruned (walk's join() strips a
 * `./` prefix, leaving the bare name). Trade-off: an explicitly passed
 * root that is itself a skipped name is now pruned too. */
const SKIP_PATTERN = new RegExp(
  `(?:^|[\\\\/])(?:${[...SKIPPED].map((name) => name.replaceAll(".", "\.")).join("|")})$`,
);

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
      for await (
        const entry of walk(path, {
          includeDirs: false,
          includeSymlinks: false,
          skip: [SKIP_PATTERN],
        })
      ) {
        let root = path;
        while (root.endsWith("\\") || root.endsWith("/")) root = root.slice(0, -1);
        if (root.startsWith("./")) root = root.slice(2);
        let relative = entry.path.startsWith(root) ? entry.path.slice(root.length) : entry.path;
        while (relative.startsWith("\\") || relative.startsWith("/")) {
          relative = relative.slice(1);
        }
        files.push(`${path}/${relative.replaceAll("\\", "/")}`);
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
  json: boolean;
  files: string[];
}

export type CliAction =
  | { readonly kind: "run"; readonly options: CliOptions }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "error"; readonly message: string };

export function parseArgs(args: string[]): CliAction {
  let unknownArg: string | undefined;
  const parsed = parseArgsStd(args, {
    boolean: ["check", "diff", "json", "help", "version"],
    string: ["_"], // keep positionals as strings: a file named "123" stays "123"
    alias: { h: "help", V: "version" },
    unknown: (arg, key) => {
      // key === "" is std's intermediate probe for single-char flags like
      // `-h`; ignore it so the alias resolution below decides the real key.
      if (key !== undefined && key !== "") {
        unknownArg ??= arg;
        return false;
      }
    },
  });
  if (parsed.help) return { kind: "help" };
  if (parsed.version) return { kind: "version" };
  if (unknownArg !== undefined) {
    return { kind: "error", message: `unknown option: ${unknownArg}` };
  }
  const options: CliOptions = {
    check: Boolean(parsed.check),
    diff: Boolean(parsed.diff),
    json: Boolean(parsed.json),
    files: parsed._.map(String),
  };
  if (options.files.length === 0) {
    return { kind: "error", message: "no files or directories given" };
  }
  if (options.json && !options.check) {
    return { kind: "error", message: "--json requires --check" };
  }
  if (options.json && options.diff) {
    return { kind: "error", message: "--json cannot be combined with --diff" };
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
  file's extension (or filename). Directives must appear at the start
  of a line.

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
      --diff             Do not write files. Print the block changes as a
                         diff and exit 1 if any file would change.
      --json             With --check, print stale blocks as a JSON array
                         of {file, line, tag} entries on stdout.
  -h, --help             Print this help message and exit.
  -V, --version          Print the version number and exit.

EXIT CODES:
  0  Success. With --check or --diff, every file is up to date.
  1  A command failed, a directive is malformed, or (with --check or
     --diff) a file is out of date.
  2  Invalid command-line usage.

EXAMPLES:
  commentsh README.md
  commentsh src docs
  commentsh --check .          # fail CI if any docs are stale
  commentsh --diff README.md   # preview changes without writing
  commentsh --check --json .   # machine-readable stale-block report

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
  let files: string[];
  try {
    files = await collectFiles(options.files);
  } catch (err) {
    if (options.json) console.log("[]");
    console.error(`commentsh: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }

  const { changed, errors, firstExitCode, staleEntries } = await processFileList(files, options);

  if (options.diff) {
    if (errors > 0) console.error(`commentsh: ${errors} error(s)`);
    else if (changed > 0) console.error(`commentsh: ${changed} file(s) would change`);
    else console.log(`commentsh: all ${files.length} file(s) up to date`);
    let exitCode = firstExitCode;
    if (changed > 0 && exitCode === 0) exitCode = 1;
    Deno.exit(exitCode);
  }

  if (options.check) {
    if (options.json) {
      console.log(JSON.stringify(staleEntries, null, 2));
      if (errors > 0 || changed > 0) {
        console.error(`commentsh: ${errors} error(s), ${changed} file(s) out of date`);
      } else console.error(`commentsh: all ${files.length} file(s) up to date`);
    } else if (errors === 0 && changed === 0) {
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

/** One stale inject block reported by check mode: file, 1-based line, and opening tag. */
export interface StaleEntry {
  readonly file: string;
  readonly line: number;
  readonly tag: string;
}

/** Aggregate outcome of processing a file list. */
export interface FileListResult {
  readonly changed: number;
  readonly errors: number;
  readonly firstExitCode: number;
  readonly staleEntries: StaleEntry[];
}

/** Process files in order, printing per-file results (and JSON entries in json mode). */
export async function processFileList(
  files: string[],
  options: CliOptions,
): Promise<FileListResult> {
  let changed = 0;
  let errors = 0;
  let firstExitCode = 0;
  const staleEntries: StaleEntry[] = [];
  for (const file of files) {
    let result: ProcessResult;
    try {
      result = await processFile(file, { check: options.check, diff: options.diff });
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
        const staleBlocks = result.staleBlocks ?? [];
        if (options.json) {
          for (const block of staleBlocks) {
            staleEntries.push({ file, line: block.line, tag: block.tag });
          }
        } else {
          console.log(`out of date: ${file}`);
          for (const block of staleBlocks) {
            console.log(`  ${blockHeader(block.line, block.tag)}`);
          }
        }
      } else {
        console.log(`updated: ${file}`);
      }
    }
  }
  return { changed, errors, firstExitCode, staleEntries };
}

if (import.meta.main) {
  await main();
}
