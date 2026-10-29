import { describe, expect, it } from 'vitest';

describe('runtime', () => {
  it('runs on Node 24, not on Bun', () => {
    expect(process.versions.bun).toBeUndefined();
    expect(process.versions.node.split('.')[0]).toBe('24');
  });
});
