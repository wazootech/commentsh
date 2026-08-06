import { assertEquals, assertNotEquals } from "@std/assert";
import { parseArgs } from "../commentsh.ts";

function runOptions(args: string[]) {
  const action = parseArgs(args);
  assertEquals(action.kind, "run");
  return action.kind === "run" ? action.options : undefined;
}

Deno.test("parses check flag and positional paths", () => {
  const options = runOptions(["--check", "README.md", "src"]);
  assertEquals(options?.check, true);
  assertEquals(options?.files, ["README.md", "src"]);
});

Deno.test("supports -- to end option parsing", () => {
  const options = runOptions(["--", "--check"]);
  assertEquals(options?.check, false);
  assertEquals(options?.files, ["--check"]);
});

Deno.test("parses the --diff flag", () => {
  const diff = runOptions(["--diff", "README.md"]);
  assertEquals(diff?.diff, true);
  assertEquals(diff?.check, false);
  assertEquals(diff?.files, ["README.md"]);
});

Deno.test("returns error for unknown options", () => {
  const action = parseArgs(["--frobnicate", "x.md"]);
  assertEquals(action.kind, "error");
  assertEquals(parseArgs(["--watch", "x.md"]).kind, "error");
  assertEquals(parseArgs(["--prefix", "#", "x.md"]).kind, "error");
  assertEquals(parseArgs(["--suffix", "#", "x.md"]).kind, "error");
});

Deno.test("returns error when no files are given", () => {
  assertEquals(parseArgs([]).kind, "error");
  assertEquals(parseArgs(["--check"]).kind, "error");
});

Deno.test("returns help and version actions", () => {
  assertEquals(parseArgs(["--help"]).kind, "help");
  assertEquals(parseArgs(["-h"]).kind, "help");
  assertEquals(parseArgs(["--version"]).kind, "version");
  assertEquals(parseArgs(["-V"]).kind, "version");
});

Deno.test("parses the --json flag with --check", () => {
  const options = runOptions(["--check", "--json", "README.md"]);
  assertEquals(options?.check, true);
  assertEquals(options?.json, true);
  assertEquals(options?.files, ["README.md"]);
});

Deno.test("rejects --json without --check", () => {
  assertEquals(parseArgs(["--json", "README.md"]).kind, "error");
});

Deno.test("rejects --json combined with --diff", () => {
  assertEquals(parseArgs(["--check", "--diff", "--json", "README.md"]).kind, "error");
});

async function withTempFile(
  name: string,
  content: string,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/${name}`;
  try {
    await Deno.writeTextFile(path, content);
    await run(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const COMMENTSH = `${import.meta.dirname}/../commentsh.ts`;

async function runCommentsh(cwd: string, ...args: string[]) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-write", "--allow-run", COMMENTSH, ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test("--check --json prints stale blocks as structured entries", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo hello -->\n\nstale\n\n<!-- /cmd -->\n",
    async (path) => {
      const dir = path.slice(0, path.lastIndexOf("/"));
      const result = await runCommentsh(dir, "--check", "--json", "test.md");
      assertEquals(result.code, 1);
      assertEquals(JSON.parse(result.stdout), [
        { file: "test.md", line: 1, tag: "<!-- cmd: echo hello -->" },
      ]);
    },
  );
});

Deno.test("--check --json prints an empty array when up to date", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo hello -->\n\nhello\n\n<!-- /cmd -->\n",
    async (path) => {
      const dir = path.slice(0, path.lastIndexOf("/"));
      const result = await runCommentsh(dir, "--check", "--json", "test.md");
      assertEquals(result.code, 0);
      assertEquals(result.stdout.trim(), "[]");
    },
  );
});

const FAILING_COMMAND = Deno.build.os === "windows" ? "exit /b 1" : "false";

Deno.test("--check --json keeps stdout valid JSON when a directive fails", async () => {
  await withTempFile(
    "test.md",
    `<!-- cmd!: ${FAILING_COMMAND} -->\n`,
    async (path) => {
      const dir = path.slice(0, path.lastIndexOf("/"));
      const result = await runCommentsh(dir, "--check", "--json", "test.md");
      assertEquals(result.code, 1);
      assertEquals(JSON.parse(result.stdout), []);
      assertNotEquals(result.stderr, "");
    },
  );
});
