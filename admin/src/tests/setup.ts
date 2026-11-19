import { createRequire } from 'node:module';
import { afterEach } from 'vitest';

const g = globalThis as typeof globalThis & { __ertadJsdomReady?: boolean };
if (!g.__ertadJsdomReady) {
  process.env.SSR = '';
  const require = createRequire(import.meta.url);
  const { builtinEnvironments } = require('vitest/runtime') as typeof import('vitest/runtime');
  await builtinEnvironments.jsdom.setup(globalThis, {});
  g.__ertadJsdomReady = true;
}

await import('@testing-library/jest-dom/vitest');
const { cleanup, configure } = await import('@testing-library/react');

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Async rendering waits are not application latency budgets. Preserve every assertion
// while allowing deferred React updates on shared development/CI hosts.
configure({ asyncUtilTimeout: 10000 });

afterEach(() => {
  cleanup();
});
