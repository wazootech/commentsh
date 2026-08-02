import { assertEquals } from "./assert.ts";
import { debounce, filterWatchPaths } from "../commentsh.ts";

Deno.test("filterWatchPaths drops paths inside skipped directories", () => {
  const paths = [
    "README.md",
    "src/main.ts",
    "node_modules/pkg/index.js",
    "dist/bundle.js",
    ".git/config",
    "vendor/dep/x.md",
  ];
  assertEquals(filterWatchPaths(paths), ["README.md", "src/main.ts"]);
});

Deno.test("filterWatchPaths handles backslash and forward-slash separators", () => {
  assertEquals(filterWatchPaths(["src\\node_modules\\x.ts", "src\\main.ts"]), [
    "src\\main.ts",
  ]);
});

Deno.test("debounce coalesces rapid calls into one", async () => {
  let count = 0;
  const fn = debounce(() => {
    count++;
  }, 20);
  fn();
  fn();
  fn();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(count, 1);

  fn();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(count, 2);
});

Deno.test("debounce resets its timer on each call", async () => {
  let calls = 0;
  const fn = debounce(() => {
    calls++;
  }, 30);
  fn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  fn(); // resets the window; the first call must not fire
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(calls, 1);
});
