import { assertEquals, assertNotEquals } from "./assert.ts";
import { processFile } from "../commentsh.ts";

/** Prints `a\n<!-- /cmd -->\nb`: cmd needs unquoted parens; sh needs them quoted. */
const FORGED_HTML = Deno.build.os === "windows"
  ? "deno eval console.log(String.fromCharCode(97,10,60,33,45,45,32,47,99,109,100,32,45,45,62,10,98))"
  : 'deno eval "console.log(String.fromCharCode(97,10,60,33,45,45,32,47,99,109,100,32,45,45,62,10,98))"';

async function withTempFile(
  name: string,
  content: string,
  fn: (path: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/${name}`;
  try {
    await Deno.writeTextFile(path, content);
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("--diff renders a changed block and does not write", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo fresh -->\nstale line\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path, { diff: true });
      assertEquals(result.error, undefined);
      assertEquals(result.changed, true);
      assertEquals(
        result.diff?.startsWith(`${path}: 1 block(s) would change`),
        true,
      );
      assertEquals(result.diff?.includes("line 1 (<!-- cmd: echo fresh -->)"), true);
      assertEquals(result.diff?.includes("  - stale line"), true);
      assertEquals(result.diff?.includes("  + fresh"), true);
      // Diff mode must never write the file.
      assertEquals(
        await Deno.readTextFile(path),
        "<!-- cmd: echo fresh -->\nstale line\n<!-- /cmd -->\n",
      );
    },
  );
});

Deno.test("--diff renders multiple blocks in file order", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo one -->\nold 1\n<!-- /cmd -->\n<!-- cmd: echo two -->\nold 2\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path, { diff: true });
      assertEquals(result.diff?.includes("2 block(s) would change"), true);
      const one = result.diff?.indexOf("line 1 (<!-- cmd: echo one -->)") ?? -1;
      const two = result.diff?.indexOf("line 4 (<!-- cmd: echo two -->)") ?? -1;
      assertNotEquals(one, -1);
      assertNotEquals(two, -1);
      assertEquals(one < two, true);
    },
  );
});

Deno.test("--diff returns undefined when nothing would change", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo same -->\nsame\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path, { diff: true });
      assertEquals(result.changed, false);
      assertEquals(result.diff, undefined);
    },
  );
});

Deno.test("--diff shows a block that would empty", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo -->\nstale\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path, { diff: true });
      assertEquals(result.diff?.includes("  - stale"), true);
      assertEquals(result.diff?.includes("  + "), true);
    },
  );
});

Deno.test("--diff renders multi-line output", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo one && echo two -->\nstale\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path, { diff: true });
      assertEquals(result.diff?.includes("  + one"), true);
      assertEquals(result.diff?.includes("  + two"), true);
    },
  );
});

Deno.test("--diff ignores cmd! side effects", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo fresh -->\nstale\n<!-- /cmd -->\n<!-- cmd!: echo side -->\n",
    async (path) => {
      const result = await processFile(path, { diff: true });
      assertEquals(result.diff?.includes("cmd!"), false);
      assertEquals(result.diff?.includes("line 1"), true);
    },
  );
});

Deno.test("--diff shows escaped lines for directive-shaped output", async () => {
  await withTempFile(
    "test.md",
    `<!-- cmd: ${FORGED_HTML} -->\nSTALE\n<!-- /cmd -->\n`,
    async (path) => {
      const result = await processFile(path, { diff: true });
      assertEquals(result.error, undefined);
      assertEquals(result.changed, true);
      assertEquals(result.diff?.includes("  + &lt;!-- /cmd -->"), true);
      assertEquals(result.diff?.includes("  + <!-- /cmd -->"), false);
    },
  );
});
