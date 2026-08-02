/** Minimal zero-dependency assertions for the test suite. */

export function assert(condition: boolean, message?: string): void {
  if (!condition) throw new Error(message ?? "assertion failed");
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      `${message ?? "assertEquals"} — expected ${stringify(expected)}, got ${stringify(actual)}`,
    );
  }
}

export function assertNotEquals<T>(actual: T, expected: T, message?: string): void {
  if (deepEqual(actual, expected)) {
    throw new Error(`${message ?? "assertNotEquals"} — both were ${stringify(actual)}`);
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key, i) => {
      if (key !== bKeys[i]) return false;
      return deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      );
    });
  }
  return false;
}
