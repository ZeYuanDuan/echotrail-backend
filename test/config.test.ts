import { describe, expect, it } from 'vitest';
import { resolvePort } from '../src/config.js';

describe('resolvePort', () => {
  it('uses Cloud Run default port when PORT is absent', () => {
    expect(resolvePort()).toBe(8080);
  });

  it('uses an explicit valid PORT value', () => {
    expect(resolvePort('9090')).toBe(9090);
  });

  it('rejects invalid port values', () => {
    expect(() => resolvePort('not-a-port')).toThrow('PORT must be an integer from 1 to 65535');
  });
});
