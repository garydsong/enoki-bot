import type { Clock, Rng } from '../types.js';

/** Production implementations. Tests inject fakes instead. */
export const systemClock: Clock = { now: () => Date.now() };

export const systemRng: Rng = {
  intBetween(min, max) {
    if (max < min) return min;
    return min + Math.floor(Math.random() * (max - min + 1));
  },
};
