import { assertEquals, assertNotEquals } from "./assert.ts";
import { processFile } from "../commentsh.ts";

/** A command that exits with a non-zero code on every platform. */
const FAILING_COMMAND = Deno.build.os === "windows" ? "exit /b 1" : "false";

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

Deno.test("exec block injects stdout and is idempotent", async () => {
  await withTempFile(
    "test.md",
    ["# Test", "", "<!-- exec: echo hello world -->", "stale", "<!-- /exec -->", ""].join(
      "\n",
    ),
    async (path) => {
      const first = await processFile(path);
      assertEquals(first.error, undefined);
      assertEquals(first.changed, true);
      assertEquals(
        await Deno.readTextFile(path),
        ["# Test", "", "<!-- exec: echo hello world -->", "hello world", "<!-- /exec -->", ""]
          .join("\n"),
      );

      const second = await processFile(path);
      assertEquals(second.error, undefined);
      assertEquals(second.changed, false);
    },
  );
});

Deno.test("run directive executes and leaves the file unchanged", async () => {
  await withTempFile(
    "test.py",
    "# run: echo side-effect\n# hello\n",
    async (path) => {
      const result = await processFile(path);
      assertEquals(result.error, undefined);
      assertEquals(result.changed, false);
      assertEquals(await Deno.readTextFile(path), "# run: echo side-effect\n# hello\n");
    },
  );
});

Deno.test("check mode reports drift without writing", async () => {
  await withTempFile(
    "test.md",
    "<!-- exec: echo hello -->\nstale\n<!-- /exec -->\n",
    async (path) => {
      const result = await processFile(path, { check: true });
      assertEquals(result.changed, true);
      assertEquals(
        await Deno.readTextFile(path),
        "<!-- exec: echo hello -->\nstale\n<!-- /exec -->\n",
      );
    },
  );
});

Deno.test("check mode passes when the file is up to date", async () => {
  await withTempFile(
    "test.md",
    "<!-- exec: echo hello -->\nhello\n<!-- /exec -->\n",
    async (path) => {
      const result = await processFile(path, { check: true });
      assertEquals(result.changed, false);
      assertEquals(result.error, undefined);
    },
  );
});

Deno.test("failed exec command reports an error and does not write", async () => {
  await withTempFile(
    "test.md",
    `<!-- exec: ${FAILING_COMMAND} -->\nstale\n<!-- /exec -->\n`,
    async (path) => {
      const result = await processFile(path);
      assertNotEquals(result.error, undefined);
      assertNotEquals(result.exitCode, 0);
      // The stale content must be preserved.
      assertEquals(
        await Deno.readTextFile(path),
        `<!-- exec: ${FAILING_COMMAND} -->\nstale\n<!-- /exec -->\n`,
      );
    },
  );
});

Deno.test("failed run directive reports an error", async () => {
  await withTempFile(
    "test.sh",
    `# run: ${FAILING_COMMAND}\n# hello\n`,
    async (path) => {
      const result = await processFile(path);
      assertNotEquals(result.error, undefined);
      assertNotEquals(result.exitCode, 0);
      assertEquals(await Deno.readTextFile(path), `# run: ${FAILING_COMMAND}\n# hello\n`);
    },
  );
});

Deno.test("malformed exec block is reported without writing", async () => {
  await withTempFile(
    "test.md",
    "<!-- exec: echo hi -->\nno closing tag here\n",
    async (path) => {
      const result = await processFile(path);
      assertNotEquals(result.error, undefined);
      assertEquals(
        await Deno.readTextFile(path),
        "<!-- exec: echo hi -->\nno closing tag here\n",
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
    "<!-- exec: echo hello -->\n\nstale\n\n<!-- /exec -->\n",
    async (path) => {
      const result = await processFile(path);
      assertEquals(result.changed, true);
      assertEquals(result.error, undefined);
      assertEquals(
        await Deno.readTextFile(path),
        "<!-- exec: echo hello -->\n\nhello\n\n<!-- /exec -->\n",
      );
    },
  );
});

Deno.test("formatter-friendly blank lines are stable (idempotent)", async () => {
  await withTempFile(
    "test.md",
    "<!-- exec: echo hello -->\n\nhello\n\n<!-- /exec -->\n",
    async (path) => {
      const result = await processFile(path);
      assertEquals(result.changed, false);
      assertEquals(result.error, undefined);
      assertEquals(
        await Deno.readTextFile(path),
        "<!-- exec: echo hello -->\n\nhello\n\n<!-- /exec -->\n",
      );
    },
  );
});

Deno.test("prefix override forces comment syntax", async () => {
  await withTempFile(
    "test.txt",
    "# exec: echo forced\nstale\n# /exec\n",
    async (path) => {
      const result = await processFile(path, {
        prefixOverride: "#",
        suffixOverride: "",
      });
      assertEquals(result.error, undefined);
      assertEquals(result.changed, true);
      assertEquals(
        await Deno.readTextFile(path),
        "# exec: echo forced\nforced\n# /exec\n",
      );
    },
  );
});
