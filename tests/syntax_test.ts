import { assertEquals } from "./assert.ts";
import { syntaxForPath } from "../commentsh.ts";

Deno.test("markdown uses HTML comments", () => {
  assertEquals(syntaxForPath("README.md"), { prefix: "<!--", suffix: "-->" });
  assertEquals(syntaxForPath("docs/guide.markdown"), {
    prefix: "<!--",
    suffix: "-->",
  });
});

Deno.test("web markup uses HTML comments", () => {
  assertEquals(syntaxForPath("index.html"), { prefix: "<!--", suffix: "-->" });
  assertEquals(syntaxForPath("sitemap.xml"), { prefix: "<!--", suffix: "-->" });
});

Deno.test("C-family languages use // comments", () => {
  assertEquals(syntaxForPath("src/main.ts"), { prefix: "//", suffix: "" });
  assertEquals(syntaxForPath("main.go"), { prefix: "//", suffix: "" });
  assertEquals(syntaxForPath("lib.rs"), { prefix: "//", suffix: "" });
  assertEquals(syntaxForPath("script.js"), { prefix: "//", suffix: "" });
});

Deno.test("Python, Ruby, YAML, and shell use # comments", () => {
  assertEquals(syntaxForPath("scripts/gen.py"), { prefix: "#", suffix: "" });
  assertEquals(syntaxForPath("config.yml"), { prefix: "#", suffix: "" });
  assertEquals(syntaxForPath("setup.sh"), { prefix: "#", suffix: "" });
});

Deno.test("SQL and Lua use -- comments", () => {
  assertEquals(syntaxForPath("schema.sql"), { prefix: "--", suffix: "" });
  assertEquals(syntaxForPath("game.lua"), { prefix: "--", suffix: "" });
});

Deno.test("CSS uses block comments", () => {
  assertEquals(syntaxForPath("styles.css"), { prefix: "/*", suffix: "*/" });
});

Deno.test("files without extensions are matched by name", () => {
  assertEquals(syntaxForPath("Dockerfile"), { prefix: "#", suffix: "" });
  assertEquals(syntaxForPath("Makefile"), { prefix: "#", suffix: "" });
  assertEquals(syntaxForPath(".gitignore"), { prefix: "#", suffix: "" });
});

Deno.test("unknown extensions fall back to HTML comments", () => {
  assertEquals(syntaxForPath("notes.txt"), { prefix: "<!--", suffix: "-->" });
  assertEquals(syntaxForPath("data.csv"), { prefix: "<!--", suffix: "-->" });
});

Deno.test("extensions are case-insensitive", () => {
  assertEquals(syntaxForPath("README.MD"), { prefix: "<!--", suffix: "-->" });
});
