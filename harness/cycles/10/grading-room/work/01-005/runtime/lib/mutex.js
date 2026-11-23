/** Per-key async mutex: serializes concurrent work on the same slot. */
const chains = new Map();

export function withKeyLock(key, fn) {
  const tail = chains.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const run = tail.then(() =>
    Promise.resolve(fn()).finally(() => release())
  );
  chains.set(
    key,
    Promise.all([run, gate]).then(() => undefined)
  );
  return run;
}