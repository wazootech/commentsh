import { assertEquals } from "@std/assert";
import { collectDirectives, escapeOutput } from "../commentsh.ts";
import type { CommentSyntax } from "../commentsh.ts";

const MD: CommentSyntax = { prefix: "<!--", suffix: "-->" };
const SLASH: CommentSyntax = { prefix: "//", suffix: "" };
const HASH: CommentSyntax = { prefix: "#", suffix: "" };
const DASH: CommentSyntax = { prefix: "--", suffix: "" };

Deno.test("finds an inject block in markdown", () => {
  const text = [
    "# Title",
    "",
    "<!-- cmd: echo hello -->",
    "stale output",
    "<!-- /cmd -->",
    "",
    "Done.",
  ].join("\n");
  const directives = collectDirectives(text, MD);
  assertEquals(directives.length, 1);
  assertEquals(directives[0].kind, "inject");
  assertEquals(directives[0].command, "echo hello");
  assertEquals(directives[0].malformed, false);
  assertEquals(directives[0].endTagStart !== undefined, true);
  assertEquals(directives[0].line, 3);
});

Deno.test("finds multiple directives in order", () => {
  const text = [
    "<!-- cmd: echo one -->",
    "x",
    "<!-- /cmd -->",
    "<!-- cmd!: echo two -->",
    "<!-- cmd: echo three -->",
    "y",
    "<!-- /cmd -->",
  ].join("\n");
  const directives = collectDirectives(text, MD);
  assertEquals(directives.map((d) => d.kind), ["inject", "run", "inject"]);
  assertEquals(directives.map((d) => d.command), [
    "echo one",
    "echo two",
    "echo three",
  ]);
});

Deno.test("cmd! side effects need no closing tag and are never malformed", () => {
  const text = "<!-- cmd!: echo hi -->\n<!-- next -->\n";
  const directives = collectDirectives(text, MD);
  assertEquals(directives.length, 1);
  assertEquals(directives[0].kind, "run");
  assertEquals(directives[0].command, "echo hi");
  assertEquals(directives[0].malformed, false);
  assertEquals(directives[0].endTagStart, undefined);
});

Deno.test("ignores directives that do not start a line", () => {
  const inline = "text <!-- cmd: echo hi -->\n<!-- /cmd -->\n";
  assertEquals(collectDirectives(inline, MD).length, 0);
});

Deno.test("flags inject blocks without a closing tag as malformed", () => {
  const text = "<!-- cmd: echo hi -->\nsome content\n";
  const directives = collectDirectives(text, MD);
  assertEquals(directives.length, 1);
  assertEquals(directives[0].malformed, true);
  assertEquals(directives[0].endTagStart, undefined);
});

Deno.test("parses cmd! directives with // comments", () => {
  const text = "// cmd!: cargo build\n// hello\n";
  const directives = collectDirectives(text, SLASH);
  assertEquals(directives.length, 1);
  assertEquals(directives[0].kind, "run");
  assertEquals(directives[0].command, "cargo build");
});

Deno.test("trims trailing whitespace from commands", () => {
  const text = "# cmd!: pip install -r requirements.txt  \n# x\n";
  const directives = collectDirectives(text, HASH);
  assertEquals(directives[0].command, "pip install -r requirements.txt");
});

Deno.test("parses -- comments and indented directives", () => {
  const text = "  -- cmd: psql -f seed.sql\n-- /cmd\n";
  const directives = collectDirectives(text, DASH);
  assertEquals(directives.length, 1);
  assertEquals(directives[0].command, "psql -f seed.sql");
  assertEquals(directives[0].malformed, false);
});

Deno.test("does not treat unrelated comments as directives", () => {
  const text = [
    "// TODO: implement this",
    "// go:generate stringer -type=Pill",
    "// NOTCMD: nope",
    "/* cmd: css comment is fine here */",
  ].join("\n");
  assertEquals(collectDirectives(text, SLASH).length, 0);
});

Deno.test("cmd! inside an open block is treated as content", () => {
  const text = [
    "<!-- cmd: echo outer -->",
    "<!-- cmd!: echo inner -->",
    "<!-- /cmd -->",
  ].join("\n");
  const directives = collectDirectives(text, MD);
  assertEquals(directives.length, 1);
  assertEquals(directives[0].kind, "inject");
  assertEquals(directives[0].command, "echo outer");
});

Deno.test("an empty file has no directives", () => {
  assertEquals(collectDirectives("", MD).length, 0);
});

Deno.test("handles CRLF line endings", () => {
  const text = "<!-- cmd: echo hi -->\r\nstale\r\n<!-- /cmd -->\r\n";
  const directives = collectDirectives(text, MD);
  assertEquals(directives.length, 1);
  assertEquals(directives[0].kind, "inject");
  assertEquals(directives[0].command, "echo hi");
  assertEquals(directives[0].malformed, false);
});

Deno.test("rejects malformed keyword forms", () => {
  const text = [
    "<!-- cmd !: echo a -->",
    "<!-- cmd!!: echo b -->",
    "<!-- cmdx: echo c -->",
    "<!-- /cmd! -->",
  ].join("\n");
  assertEquals(collectDirectives(text, MD).length, 0);
});

Deno.test("accepts empty commands", () => {
  const directives = collectDirectives("<!-- cmd: -->\n<!-- /cmd -->\n", MD);
  assertEquals(directives.length, 1);
  assertEquals(directives[0].command, "");
});

Deno.test("old exec:/run: lines are inert text", () => {
  const text = [
    "<!-- exec: echo old -->",
    "stale",
    "<!-- /exec -->",
    "# run: echo old too",
  ].join("\n");
  assertEquals(collectDirectives(text, MD).length, 0);
  assertEquals(collectDirectives(text, HASH).length, 0);
});

Deno.test("escapeOutput neutralizes forged closing tags", () => {
  assertEquals(escapeOutput("a\n<!-- /cmd -->\nb", MD), "a\n&lt;!-- /cmd -->\nb");
});

Deno.test("escapeOutput neutralizes forged opening tags", () => {
  assertEquals(escapeOutput("<!-- cmd: fake -->\nx", MD), "&lt;!-- cmd: fake -->\nx");
});

Deno.test("escapeOutput leaves ordinary lines and bare --> lines alone", () => {
  assertEquals(escapeOutput("plain\nx --> y\n-->", MD), "plain\nx --> y\n-->");
});

Deno.test("escapeOutput escapes each syntax's comment open", () => {
  assertEquals(escapeOutput("// /cmd\n// cmd: x", SLASH), "/// /cmd\n/// cmd: x");
  assertEquals(escapeOutput("# /cmd", HASH), "## /cmd");
  assertEquals(escapeOutput("-- /cmd", DASH), "--- /cmd");
  assertEquals(escapeOutput("/* /cmd */", { prefix: "/*", suffix: "*/" }), "/** /cmd */");
});

Deno.test("escapeOutput is idempotent", () => {
  const escaped = escapeOutput("a\n<!-- /cmd -->\nb", MD);
  assertEquals(escapeOutput(escaped, MD), escaped);
});

Deno.test("escapeOutput handles CRLF output lines", () => {
  assertEquals(
    escapeOutput("<!-- /cmd -->\r\nx\r\n", MD),
    "&lt;!-- /cmd -->\r\nx\r\n",
  );
});
