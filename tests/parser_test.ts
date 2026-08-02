import { assertEquals } from "./assert.ts";
import { collectDirectives } from "../commentsh.ts";
import type { CommentSyntax } from "../commentsh.ts";

const MD: CommentSyntax = { prefix: "<!--", suffix: "-->" };
const SLASH: CommentSyntax = { prefix: "//", suffix: "" };
const HASH: CommentSyntax = { prefix: "#", suffix: "" };
const DASH: CommentSyntax = { prefix: "--", suffix: "" };

Deno.test("finds an exec block in markdown", () => {
  const text = [
    "# Title",
    "",
    "<!-- exec: echo hello -->",
    "stale output",
    "<!-- /exec -->",
    "",
    "Done.",
  ].join("\n");
  const directives = collectDirectives(text, MD);
  assertEquals(directives.length, 1);
  assertEquals(directives[0].kind, "exec");
  assertEquals(directives[0].command, "echo hello");
  assertEquals(directives[0].malformed, false);
  assertEquals(directives[0].hasEndTag, true);
  assertEquals(directives[0].line, 3);
});

Deno.test("finds multiple directives in order", () => {
  const text = [
    "<!-- exec: echo one -->",
    "x",
    "<!-- /exec -->",
    "<!-- run: echo two -->",
    "<!-- exec: echo three -->",
    "y",
    "<!-- /exec -->",
  ].join("\n");
  const directives = collectDirectives(text, MD);
  assertEquals(directives.map((d) => d.kind), ["exec", "run", "exec"]);
  assertEquals(directives.map((d) => d.command), [
    "echo one",
    "echo two",
    "echo three",
  ]);
});

Deno.test("ignores directives that do not start a line", () => {
  const inline = "text <!-- exec: echo hi -->\n<!-- /exec -->\n";
  assertEquals(collectDirectives(inline, MD).length, 0);
});

Deno.test("flags exec blocks without a closing tag as malformed", () => {
  const text = "<!-- exec: echo hi -->\nsome content\n";
  const directives = collectDirectives(text, MD);
  assertEquals(directives.length, 1);
  assertEquals(directives[0].malformed, true);
  assertEquals(directives[0].hasEndTag, false);
});

Deno.test("parses run directives with // comments", () => {
  const text = "// run: cargo build\n// hello\n";
  const directives = collectDirectives(text, SLASH);
  assertEquals(directives.length, 1);
  assertEquals(directives[0].kind, "run");
  assertEquals(directives[0].command, "cargo build");
});

Deno.test("trims trailing whitespace from commands", () => {
  const text = "# run: pip install -r requirements.txt  \n# x\n";
  const directives = collectDirectives(text, HASH);
  assertEquals(directives[0].command, "pip install -r requirements.txt");
});

Deno.test("parses -- comments and indented directives", () => {
  const text = "  -- exec: psql -f seed.sql\n-- /exec\n";
  const directives = collectDirectives(text, DASH);
  assertEquals(directives.length, 1);
  assertEquals(directives[0].command, "psql -f seed.sql");
  assertEquals(directives[0].malformed, false);
});

Deno.test("does not treat unrelated comments as directives", () => {
  const text = [
    "// TODO: implement this",
    "// go:generate stringer -type=Pill",
    "// NOTEXEC: nope",
    "/* exec: css comment is fine here */",
  ].join("\n");
  assertEquals(collectDirectives(text, SLASH).length, 0);
});

Deno.test("an empty file has no directives", () => {
  assertEquals(collectDirectives("", MD).length, 0);
});
