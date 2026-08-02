import { assertEquals } from "./assert.ts";
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

Deno.test("parses prefix and suffix overrides in both forms", () => {
  const options = runOptions(["--prefix", "--", "--suffix=", "schema.sql"]);
  assertEquals(options?.prefix, "--");
  assertEquals(options?.suffix, "");
  assertEquals(options?.files, ["schema.sql"]);

  const longForm = runOptions(["--prefix=#", "--suffix=##", "a.py"]);
  assertEquals(longForm?.prefix, "#");
  assertEquals(longForm?.suffix, "##");
});

Deno.test("supports -- to end option parsing", () => {
  const options = runOptions(["--", "--check"]);
  assertEquals(options?.check, false);
  assertEquals(options?.files, ["--check"]);
});

Deno.test("returns error for unknown options", () => {
  const action = parseArgs(["--frobnicate", "x.md"]);
  assertEquals(action.kind, "error");
});

Deno.test("returns error when no files are given", () => {
  assertEquals(parseArgs([]).kind, "error");
  assertEquals(parseArgs(["--check"]).kind, "error");
});

Deno.test("returns error when a flag value is missing", () => {
  assertEquals(parseArgs(["--prefix"]).kind, "error");
});

Deno.test("returns help and version actions", () => {
  assertEquals(parseArgs(["--help"]).kind, "help");
  assertEquals(parseArgs(["-h"]).kind, "help");
  assertEquals(parseArgs(["--version"]).kind, "version");
  assertEquals(parseArgs(["-V"]).kind, "version");
});

Deno.test("parses --diff and --watch flags", () => {
  const diff = runOptions(["--diff", "README.md"]);
  assertEquals(diff?.diff, true);
  assertEquals(diff?.watch, false);
  assertEquals(diff?.files, ["README.md"]);

  const watch = runOptions(["--watch", "src"]);
  assertEquals(watch?.watch, true);
  assertEquals(watch?.check, false);
  assertEquals(watch?.files, ["src"]);

  const both = runOptions(["--watch", "--diff", "."]);
  assertEquals(both?.watch, true);
  assertEquals(both?.diff, true);
});

Deno.test("rejects --watch combined with --check", () => {
  assertEquals(parseArgs(["--watch", "--check", "."]).kind, "error");
  assertEquals(parseArgs(["--check", "--watch", "."]).kind, "error");
});
