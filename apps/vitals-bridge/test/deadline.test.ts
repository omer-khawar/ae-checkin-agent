import { describe, expect, it } from 'vitest';
import { withDeadline } from '../src/deadline.js';

describe('withDeadline', () => {
  it('returns the value when the promise settles first', async () => {
    const r = await withDeadline(Promise.resolve(42), 1_000);
    expect(r).toEqual({ timedOut: false, value: 42 });
  });

  it('returns timedOut when the deadline passes first (the work is not cancelled)', async () => {
    let finished = false;
    const slow = new Promise<void>((resolve) =>
      setTimeout(() => {
        finished = true;
        resolve();
      }, 60),
    );
    const t0 = Date.now();
    const r = await withDeadline(slow, 10);
    expect(r).toEqual({ timedOut: true });
    expect(Date.now() - t0).toBeLessThan(55);
    expect(finished).toBe(false);
    await slow;
    expect(finished).toBe(true);
  });

  it('propagates a rejection as an Error (wrapping a non-Error reason)', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 100)).rejects.toThrow('boom');
    // A non-Error reason is deliberate here: the helper must wrap it, not leak a bare string.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await expect(withDeadline(Promise.reject('plain'), 100)).rejects.toThrow('plain');
  });
});
