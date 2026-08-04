import { assertEquals, assertNotEquals } from "./assert.ts";
import { processFile, unifiedDiff } from "../commentsh.ts";

Deno.test("unifiedDiff renders a simple replacement", () => {
  const diff = unifiedDiff("a\nstale\nb\n", "a\nfresh\nb\n", "test.md");
  assertEquals(
    diff,
    [
      "diff --git a/test.md b/test.md",
      "--- a/test.md",
      "+++ b/test.md",
      "@@ -1,3 +1,3 @@",
      " a",
      "-stale",
      "+fresh",
      " b",
    ].join("\n"),
  );
});

Deno.test("unifiedDiff returns empty for identical texts", () => {
  assertEquals(unifiedDiff("a\nb\n", "a\nb\n", "x.md"), "");
});

Deno.test("unifiedDiff shows pure insertions and deletions", () => {
  const inserted = unifiedDiff("a\nc\n", "a\nb\nc\n", "x.md");
  assertEquals(inserted.includes("+b"), true);
  assertEquals(inserted.includes("-b"), false);

  const deleted = unifiedDiff("a\nb\nc\n", "a\nc\n", "x.md");
  assertEquals(deleted.includes("-b"), true);
  assertEquals(deleted.includes("+b"), false);
});

Deno.test("unifiedDiff merges nearby changes into one hunk", () => {
  const diff = unifiedDiff(
    "1\n2\n3\n4\n5\n",
    "1\nX\n3\nY\n5\n",
    "x.md",
  );
  const headers = diff.split("\n").filter((line) => line.startsWith("@@"));
  assertEquals(headers.length, 1);
});

Deno.test("unifiedDiff splits distant changes into multiple hunks", () => {
  const a: string[] = [];
  const b: string[] = [];
  for (let i = 1; i <= 40; i++) a.push(`line ${i}`);
  for (let i = 1; i <= 40; i++) {
    b.push(i === 2 ? "changed 2" : i === 38 ? "changed 38" : `line ${i}`);
  }
  const diff = unifiedDiff(a.join("\n") + "\n", b.join("\n") + "\n", "x.md");
  const headers = diff.split("\n").filter((line) => line.startsWith("@@"));
  assertEquals(headers.length, 2);
});

Deno.test("processFile with diff option returns a diff and does not write", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/test.md`;
  try {
    await Deno.writeTextFile(
      path,
      "<!-- cmd: echo hello -->\nstale\n<!-- /cmd -->\n",
    );
    const result = await processFile(path, { diff: true });
    assertEquals(result.changed, true);
    assertNotEquals(result.diff, undefined);
    assertEquals(result.diff?.includes("-stale"), true);
    assertEquals(result.diff?.includes("+hello"), true);
    // Nothing was written to disk.
    assertEquals(
      await Deno.readTextFile(path),
      "<!-- cmd: echo hello -->\nstale\n<!-- /cmd -->\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("processFile with diff on an up-to-date file has no diff", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/test.md`;
  try {
    await Deno.writeTextFile(
      path,
      "<!-- cmd: echo hello -->\nhello\n<!-- /cmd -->\n",
    );
    const result = await processFile(path, { diff: true });
    assertEquals(result.changed, false);
    assertEquals(result.diff, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
