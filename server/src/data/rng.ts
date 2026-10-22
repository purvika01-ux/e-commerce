/** Small seeded PRNG (mulberry32) plus distribution helpers, so generated data is reproducible. */
export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  bool(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: readonly { value: T; weight: number }[]): T;
  normal(mean: number, sd: number): number;
  logNormal(median: number, sigma: number): number;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (mean: number, sd: number) => {
    const u = Math.max(next(), 1e-12);
    const v = next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    bool: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted: (items) => {
      const total = items.reduce((s, i) => s + i.weight, 0);
      let r = next() * total;
      for (const i of items) {
        r -= i.weight;
        if (r <= 0) return i.value;
      }
      return items[items.length - 1].value;
    },
    normal,
    logNormal: (median, sigma) => median * Math.exp(normal(0, sigma)),
  };
}
