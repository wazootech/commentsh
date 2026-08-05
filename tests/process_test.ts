import { assertEquals, assertNotEquals } from "./assert.ts";
import { collectDirectives, collectFiles, processFile, syntaxForPath } from "../commentsh.ts";

/** A command that exits with a non-zero code on every platform. */
const FAILING_COMMAND = Deno.build.os === "windows" ? "exit /b 1" : "false";

/** Prints `a\n// /cmd\nb`: cmd needs unquoted parens; sh needs them quoted. */
const FORGED_SLASH = Deno.build.os === "windows"
  ? "deno eval console.log(String.fromCharCode(97,10,47,47,32,47,99,109,100,10,98))"
  : 'deno eval "console.log(String.fromCharCode(97,10,47,47,32,47,99,109,100,10,98))"';

/** Prints `a\n<!-- /cmd -->\nb`. */
const FORGED_HTML = Deno.build.os === "windows"
  ? "deno eval console.log(String.fromCharCode(97,10,60,33,45,45,32,47,99,109,100,32,45,45,62,10,98))"
  : 'deno eval "console.log(String.fromCharCode(97,10,60,33,45,45,32,47,99,109,100,32,45,45,62,10,98))"';

/** Prints `x --> y`. */
const BARE_ARROW = Deno.build.os === "windows"
  ? "deno eval console.log(String.fromCharCode(120,32,45,45,62,32,121))"
  : 'deno eval "console.log(String.fromCharCode(120,32,45,45,62,32,121))"';

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

Deno.test("cmd block injects stdout and is idempotent", async () => {
  await withTempFile(
    "test.md",
    ["# Test", "", "<!-- cmd: echo hello world -->", "stale", "<!-- /cmd -->", ""].join(
      "\n",
    ),
    async (path) => {
      const first = await processFile(path);
      assertEquals(first.error, undefined);
      assertEquals(first.changed, true);
      assertEquals(
        await Deno.readTextFile(path),
        ["# Test", "", "<!-- cmd: echo hello world -->", "hello world", "<!-- /cmd -->", ""]
          .join("\n"),
      );

      const second = await processFile(path);
      assertEquals(second.error, undefined);
      assertEquals(second.changed, false);
    },
  );
});

Deno.test("cmd! directive executes and leaves the file unchanged", async () => {
  await withTempFile(
    "test.py",
    "# cmd!: echo side-effect\n# hello\n",
    async (path) => {
      const result = await processFile(path);
      assertEquals(result.error, undefined);
      assertEquals(result.changed, false);
      assertEquals(
        await Deno.readTextFile(path),
        "# cmd!: echo side-effect\n# hello\n",
      );
    },
  );
});

Deno.test("check mode reports drift without writing", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo hello -->\nstale\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path, { check: true });
      assertEquals(result.changed, true);
      assertEquals(
        await Deno.readTextFile(path),
        "<!-- cmd: echo hello -->\nstale\n<!-- /cmd -->\n",
      );
    },
  );
});

Deno.test("check mode passes when the file is up to date", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo hello -->\nhello\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path, { check: true });
      assertEquals(result.changed, false);
      assertEquals(result.error, undefined);
    },
  );
});

Deno.test("failed cmd block reports an error and does not write", async () => {
  await withTempFile(
    "test.md",
    `<!-- cmd: ${FAILING_COMMAND} -->\nstale\n<!-- /cmd -->\n`,
    async (path) => {
      const result = await processFile(path);
      assertNotEquals(result.error, undefined);
      assertNotEquals(result.exitCode, 0);
      // The stale content must be preserved.
      assertEquals(
        await Deno.readTextFile(path),
        `<!-- cmd: ${FAILING_COMMAND} -->\nstale\n<!-- /cmd -->\n`,
      );
    },
  );
});

Deno.test("failed cmd! directive reports an error", async () => {
  await withTempFile(
    "test.sh",
    `# cmd!: ${FAILING_COMMAND}\n# hello\n`,
    async (path) => {
      const result = await processFile(path);
      assertNotEquals(result.error, undefined);
      assertNotEquals(result.exitCode, 0);
      assertEquals(
        await Deno.readTextFile(path),
        `# cmd!: ${FAILING_COMMAND}\n# hello\n`,
      );
    },
  );
});

Deno.test("malformed cmd block is reported without writing", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo hi -->\nno closing tag here\n",
    async (path) => {
      const result = await processFile(path);
      assertNotEquals(result.error, undefined);
      assertEquals(
        await Deno.readTextFile(path),
        "<!-- cmd: echo hi -->\nno closing tag here\n",
      );
    },
  );
});

Deno.test("binary files are skipped", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/blob.png`;
  try {
    await Deno.writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
    const result = await processFile(path);
    assertEquals(result.skipped, true);
    assertEquals(result.error, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("injection preserves existing blank-line layout", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo hello -->\n\nstale\n\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path);
      assertEquals(result.changed, true);
      assertEquals(result.error, undefined);
      assertEquals(
        await Deno.readTextFile(path),
        "<!-- cmd: echo hello -->\n\nhello\n\n<!-- /cmd -->\n",
      );
    },
  );
});

Deno.test("formatter-friendly blank lines are stable (idempotent)", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo hello -->\n\nhello\n\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path);
      assertEquals(result.changed, false);
      assertEquals(result.error, undefined);
      assertEquals(
        await Deno.readTextFile(path),
        "<!-- cmd: echo hello -->\n\nhello\n\n<!-- /cmd -->\n",
      );
    },
  );
});

Deno.test("a command ending in /cmd is not mistaken for the closing tag", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo hello /cmd -->\nstale\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path);
      assertEquals(result.error, undefined);
      assertEquals(result.changed, true);
      assertEquals(
        await Deno.readTextFile(path),
        "<!-- cmd: echo hello /cmd -->\nhello /cmd\n<!-- /cmd -->\n",
      );
    },
  );
});

Deno.test("collectFiles walks directories and skips vendor folders", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.mkdir(`${dir}/node_modules/pkg`, { recursive: true });
    await Deno.mkdir(`${dir}/.git/hooks`, { recursive: true });
    await Deno.writeTextFile(`${dir}/src/a.md`, "x");
    await Deno.writeTextFile(`${dir}/src/b.py`, "x");
    await Deno.writeTextFile(`${dir}/node_modules/pkg/c.md`, "x");
    await Deno.writeTextFile(`${dir}/.git/hooks/d.md`, "x");
    const files = await collectFiles([dir]);
    assertEquals(files.sort(), [`${dir}/src/a.md`, `${dir}/src/b.py`]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("collectFiles reports a clean error for missing paths", async () => {
  let threw = false;
  try {
    await collectFiles(["does-not-exist.md"]);
  } catch (err) {
    threw = true;
    assertNotEquals(err instanceof Error ? err.message : "", "");
  }
  assertEquals(threw, true);
});

Deno.test("check mode reports stale blocks with line and tag", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo hello -->\n\nstale\n\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path, { check: true });
      assertEquals(result.changed, true);
      assertEquals(result.staleBlocks, ["line 1 (<!-- cmd: echo hello -->)"]);
    },
  );
});

Deno.test("stale blocks are reported in file order", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo one -->\n\none-old\n\n<!-- /cmd -->\n\ntext\n\n<!-- cmd: echo two -->\n\ntwo-old\n\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path, { check: true });
      assertEquals(result.staleBlocks, [
        "line 1 (<!-- cmd: echo one -->)",
        "line 9 (<!-- cmd: echo two -->)",
      ]);
    },
  );
});

Deno.test("up-to-date files report no stale blocks", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd: echo hello -->\n\nhello\n\n<!-- /cmd -->\n",
    async (path) => {
      const result = await processFile(path, { check: true });
      assertEquals(result.changed, false);
      assertEquals(result.staleBlocks, []);
    },
  );
});

Deno.test("cmd! side-effect blocks never appear as stale", async () => {
  await withTempFile(
    "test.md",
    "<!-- cmd!: echo side -->\n",
    async (path) => {
      const result = await processFile(path);
      assertEquals(result.changed, false);
      assertEquals(result.staleBlocks, []);
    },
  );
});

Deno.test("stdout that forges a closing tag cannot corrupt the block", async () => {
  await withTempFile(
    "test.ts",
    `// cmd: ${FORGED_SLASH}\n\nOLD\n\n// /cmd\n`,
    async (path) => {
      const result = await processFile(path);
      assertEquals(result.error, undefined);
      assertEquals(result.changed, true);
      const text = await Deno.readTextFile(path);
      assertEquals(text.includes("/// /cmd"), true);
      const directives = collectDirectives(text, syntaxForPath(path));
      assertEquals(directives.length, 1);
      assertEquals(directives[0].malformed, false);
      const again = await processFile(path);
      assertEquals(again.changed, false);
    },
  );
});

Deno.test("HTML stdout cannot forge a closing tag", async () => {
  await withTempFile(
    "test.md",
    `<!-- cmd: ${FORGED_HTML} -->\n\nOLD\n\n<!-- /cmd -->\n`,
    async (path) => {
      const result = await processFile(path);
      assertEquals(result.error, undefined);
      assertEquals(result.changed, true);
      const text = await Deno.readTextFile(path);
      assertEquals(text.includes("&lt;!-- /cmd -->"), true);
      const directives = collectDirectives(text, syntaxForPath(path));
      assertEquals(directives.length, 1);
      assertEquals(directives[0].malformed, false);
      const again = await processFile(path);
      assertEquals(again.changed, false);
    },
  );
});

Deno.test("output containing --> alone is injected unchanged", async () => {
  await withTempFile(
    "test.md",
    `<!-- cmd: ${BARE_ARROW} -->\n\nOLD\n\n<!-- /cmd -->\n`,
    async (path) => {
      const result = await processFile(path);
      assertEquals(result.error, undefined);
      assertEquals(result.changed, true);
      const text = await Deno.readTextFile(path);
      assertEquals(text.includes("x --> y"), true);
      assertEquals(text.includes("&lt;!--"), false);
      const again = await processFile(path);
      assertEquals(again.changed, false);
    },
  );
});
