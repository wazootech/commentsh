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

Deno.test("supports -- to end option parsing", () => {
  const options = runOptions(["--", "--check"]);
  assertEquals(options?.check, false);
  assertEquals(options?.files, ["--check"]);
});

Deno.test("returns error for unknown options", () => {
  const action = parseArgs(["--frobnicate", "x.md"]);
  assertEquals(action.kind, "error");
  assertEquals(parseArgs(["--diff", "x.md"]).kind, "error");
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
