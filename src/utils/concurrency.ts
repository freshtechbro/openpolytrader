export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const bounded = Math.max(Math.floor(concurrency), 1);
  if (items.length === 0) return [];
  if (bounded === 1) {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += 1) {
      out.push(await fn(items[i], i));
    }
    return out;
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(bounded, items.length); i += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

