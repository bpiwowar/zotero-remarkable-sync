// Check the AsyncDisposableStack polyfill in src/utils/polyfills.ts: the bundle
// is loaded after deleting Node's built-in, so the polyfill installs.
//
// Run via `npm run test:polyfills` (bundles first).

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const NativeStack = globalThis.AsyncDisposableStack;
delete globalThis.AsyncDisposableStack;

const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, "../.scaffold/polyfills.mjs"));

if (NativeStack) {
  assert.notEqual(globalThis.AsyncDisposableStack, NativeStack);
}
const order = [];
const res = (name) => ({
  [Symbol.asyncDispose]: async () => void order.push(name),
});
{
  const stack = new globalThis.AsyncDisposableStack();
  stack.use(res("a"));
  stack.defer(() => order.push("b"));
  stack.adopt("c", (v) => order.push(v));
  await stack[Symbol.asyncDispose]();
  assert.deepEqual(order, ["c", "b", "a"]);
  assert.ok(stack.disposed);
  assert.throws(() => stack.use(res("d")));
}
{
  const stack = new globalThis.AsyncDisposableStack();
  stack.defer(() => {
    throw new Error("first");
  });
  await assert.rejects(stack.disposeAsync(), /first/);
}

console.log("polyfills: AsyncDisposableStack behaves");
