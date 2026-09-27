export function createSelectionGuard() {
  let current = { id: null, generation: 0 };

  function select(id) {
    current = { id, generation: current.generation + 1 };
    return { ...current };
  }

  function capture() {
    return { ...current };
  }

  function isCurrent(token) {
    return Boolean(token) && token.id === current.id && token.generation === current.generation;
  }

  function canApply(token, next, displayed) {
    if (!isCurrent(token) || token.id !== next.id) return false;
    return !displayed || displayed.id !== next.id || displayed.revision <= next.revision;
  }

  return { select, capture, isCurrent, canApply };
}
