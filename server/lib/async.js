// Async-aware array helpers (Array#filter/map don't await promises).
export async function filterAsync(list, pred) {
  const out = [];
  for (const item of list) if (await pred(item)) out.push(item);
  return out;
}
export const mapAsync = (list, fn) => Promise.all(list.map(fn));
