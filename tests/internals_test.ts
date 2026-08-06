import { assertEquals } from "./assert.ts";
import {
  blockHeader,
  collectDirectives,
  renderBlockDiff,
  scanTokens,
  SYNTAXES,
} from "../commentsh.ts";
import type { Directive } from "../commentsh.ts";

Deno.test("SYNTAXES exposes the five built-in syntaxes", () => {
  assertEquals(Object.keys(SYNTAXES).sort(), ["dash", "hash", "html", "slash", "star"]);
  assertEquals(SYNTAXES.html.prefix, "<!--");
  assertEquals(SYNTAXES.html.suffix, "-->");
  assertEquals(SYNTAXES.hash.prefix, "#");
  assertEquals(SYNTAXES.star.prefix, "/*");
});

Deno.test("scanTokens returns raw tokens in file order", () => {
  const text = "<!-- cmd: echo hi -->\n\n<!-- /cmd -->\n";
  const tokens = scanTokens(text, SYNTAXES.html);
  assertEquals(tokens.length, 2);
  assertEquals(tokens[0].type, "inject");
  assertEquals(tokens[0].command, "echo hi");
  assertEquals(tokens[0].line, 1);
  assertEquals(tokens[1].type, "end");
  assertEquals(tokens[1].line, 3);
  assertEquals(tokens[1].command, undefined);
});

Deno.test("scanTokens agrees with collectDirectives on the same text", () => {
  const text = "# cmd: echo one\n\n# /cmd\n\n# cmd!: touch x\n";
  const tokens = scanTokens(text, SYNTAXES.hash);
  const directives = collectDirectives(text, SYNTAXES.hash);
  assertEquals(tokens.filter((t) => t.type === "inject").length, 1);
  assertEquals(tokens.filter((t) => t.type === "run").length, 1);
  assertEquals(tokens.filter((t) => t.type === "end").length, 1);
  assertEquals(directives.length, 2);
  assertEquals(tokens.filter((t) => t.type !== "end").length, directives.length);
});

Deno.test("blockHeader and renderBlockDiff render stable text", () => {
  assertEquals(blockHeader(4, "<!-- cmd: echo hi -->"), "line 4 (<!-- cmd: echo hi -->)");
  const directive: Directive = {
    kind: "inject",
    command: "echo hi",
    line: 4,
    contentStart: 10,
    endTagStart: 20,
    malformed: false,
  };
  assertEquals(
    renderBlockDiff(directive, "<!-- cmd: echo hi -->", ["old"], ["new"]),
    "line 4 (<!-- cmd: echo hi -->)\n  - old\n  + new",
  );
});
