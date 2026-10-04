export function createSourceReader(load, update) {
  let generation = 0;
  return {
    async open(request, verification) {
      const token = ++generation;
      const state = { request, verification, loading: true, preview: null, error: '' };
      update(state);
      try {
        const preview = await load(request);
        if (token === generation) update({ ...state, loading: false, preview, error: preview.error || '' });
      } catch (error) {
        if (token === generation) update({ ...state, loading: false, error: String(error?.message || error) });
      }
    },
    close() {
      generation += 1;
      update(null);
    }
  };
}
