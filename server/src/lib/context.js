const { AsyncLocalStorage } = require('node:async_hooks');

// Carries correlation/request/payment IDs across async boundaries so every
// log line emitted while handling a request can be tagged without threading
// IDs through every function signature (spec section 19).
const storage = new AsyncLocalStorage();

function run(context, fn) {
  return storage.run({ ...(storage.getStore() || {}), ...context }, fn);
}

function get() {
  return storage.getStore() || {};
}

function set(patch) {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}

module.exports = { run, get, set };
