function createSerialLock() {
  const pending = new Map();
  return function withSerialLock(key, work) {
    const prior = pending.get(key) || Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    pending.set(key, next);
    return next.finally(() => { if (pending.get(key) === next) pending.delete(key); });
  };
}

module.exports = { createSerialLock };
