/**
 * Deterministic noise utilities for the mock source.
 *
 * Everything the mock emits must be reproducible from a seed so tests are stable and a demo
 * scenario looks the same on every laptop. We therefore avoid `Math.random()` entirely and use:
 *  - FNV-1a to turn a scenario name into a 32-bit seed,
 *  - mulberry32 as a small, well-distributed PRNG,
 *  - Box-Muller for Gaussian draws,
 *  - an AR(1) process for *autocorrelated* noise. Physiological signals drift; they do not jump
 *    like white noise. AR(1) with phi ~0.85 gives second-to-second changes of ~0.5 sd while
 *    keeping the stationary spread at exactly `sigma`.
 */

/** FNV-1a 32-bit hash of a string, used to derive a seed from a scenario name. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Uniform [0,1) generator. */
export type Rng = () => number;

/** mulberry32: tiny 32-bit PRNG with good statistical behaviour for simulation purposes. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw via Box-Muller. */
export function gaussian(rng: Rng): number {
  // Avoid log(0): map u1 into (0, 1].
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * First-order autoregressive noise: x_t = phi * x_{t-1} + sqrt(1 - phi^2) * sigma * eps_t.
 * The sqrt term keeps the stationary standard deviation equal to `sigma` for any phi in [0,1).
 */
export class AR1 {
  private x = 0;
  private readonly innovation: number;

  constructor(
    private readonly phi: number,
    sigma: number,
    private readonly rng: Rng,
  ) {
    if (phi < 0 || phi >= 1) throw new RangeError(`AR1 phi must be in [0,1), got ${phi}`);
    this.innovation = Math.sqrt(1 - phi * phi) * sigma;
  }

  next(): number {
    this.x = this.phi * this.x + this.innovation * gaussian(this.rng);
    return this.x;
  }

  reset(): void {
    this.x = 0;
  }
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
