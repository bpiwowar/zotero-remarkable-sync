// Polyfills for explicit resource management (Symbol.asyncDispose,
// AsyncDisposableStack), which rmapi-js (v14+) uses and Firefox only ships from
// version 141: Zotero 8 to 10 run on Firefox 140 ESR. Zotero 11 (Firefox 153)
// has them natively. Must be imported before anything that imports rmapi-js:
// its classes define `[Symbol.asyncDispose]` methods when the module is
// evaluated. `npm run test:polyfills` checks them.

const S = Symbol as any;
// Same fallback esbuild's and TypeScript's `using` helpers look up.
if (!S.asyncDispose) S.asyncDispose = Symbol.for("Symbol.asyncDispose");
if (!S.dispose) S.dispose = Symbol.for("Symbol.dispose");

const G = globalThis as any;
if (typeof G.AsyncDisposableStack !== "function") {
  type Cleanup = () => unknown;
  // Minimal AsyncDisposableStack: disposes in reverse order, rethrowing the
  // first error after running every cleanup.
  class AsyncDisposableStackPolyfill {
    #stack: Cleanup[] = [];
    #disposed = false;
    get disposed() {
      return this.#disposed;
    }
    #check() {
      if (this.#disposed) throw new ReferenceError("stack already disposed");
    }
    use<T>(value: T): T {
      this.#check();
      if (value !== null && value !== undefined) {
        const v = value as any;
        const fn = v[S.asyncDispose] ?? v[S.dispose];
        if (typeof fn !== "function") throw new TypeError("not disposable");
        this.#stack.push(() => fn.call(v));
      }
      return value;
    }
    adopt<T>(value: T, onDispose: (v: T) => unknown): T {
      this.#check();
      this.#stack.push(() => onDispose(value));
      return value;
    }
    defer(onDispose: () => unknown): void {
      this.#check();
      this.#stack.push(onDispose);
    }
    move(): AsyncDisposableStackPolyfill {
      this.#check();
      const next = new AsyncDisposableStackPolyfill();
      next.#stack = this.#stack;
      this.#stack = [];
      this.#disposed = true;
      return next;
    }
    async disposeAsync(): Promise<void> {
      if (this.#disposed) return;
      this.#disposed = true;
      let failed = false;
      let error: unknown;
      for (const fn of this.#stack.reverse()) {
        try {
          await fn();
        } catch (e) {
          if (!failed) error = e;
          failed = true;
        }
      }
      this.#stack = [];
      if (failed) throw error;
    }
    [S.asyncDispose]() {
      return this.disposeAsync();
    }
  }
  G.AsyncDisposableStack = AsyncDisposableStackPolyfill;
}

export {};
