import { describe, expect, it } from 'vitest';
import { matchesDomainPattern } from '../../../src/domain/domain-pattern';

describe('matchesDomainPattern', () => {
  it('matches an exact domain regardless of case', () => {
    expect(matchesDomainPattern('Example.COM', 'example.com')).toBe(true);
  });

  it('does not match subdomains with an exact pattern', () => {
    expect(matchesDomainPattern('mail.example.com', 'example.com')).toBe(false);
  });

  it.each(['mail.example.com', 'a.b.example.com', 'MAIL.Example.com'])(
    'matches %s with a wildcard pattern',
    (domain) => {
      expect(matchesDomainPattern(domain, '*.example.com')).toBe(true);
    },
  );

  it('does not match the root domain with a wildcard pattern', () => {
    expect(matchesDomainPattern('example.com', '*.example.com')).toBe(false);
  });

  it.each([
    ['badexample.com', 'example.com'],
    ['mail.badexample.com', '*.example.com'],
  ])('does not match %s with %s, which only shares the ending', (domain, pattern) => {
    expect(matchesDomainPattern(domain, pattern)).toBe(false);
  });
});
