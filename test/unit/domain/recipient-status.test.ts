import { describe, expect, it } from 'vitest';
import { canAdvanceRecipientStatus, type RecipientStatus } from '../../../src/domain/email';

describe('canAdvanceRecipientStatus', () => {
  it.each<[RecipientStatus, RecipientStatus]>([
    ['pending', 'accepted'],
    ['pending', 'delivered'],
    ['accepted', 'delivered'],
    ['delivered', 'bounced'],
    ['accepted', 'complained'],
    ['delivered', 'unsubscribed'],
    ['pending', 'suppressed'],
    ['pending', 'rejected'],
  ])('advances from %s to %s', (current, next) => {
    expect(canAdvanceRecipientStatus(current, next)).toBe(true);
  });

  it.each<[RecipientStatus, RecipientStatus]>([
    ['accepted', 'pending'],
    ['delivered', 'accepted'],
    ['bounced', 'delivered'],
    ['bounced', 'complained'],
    ['accepted', 'accepted'],
  ])('does not move from %s to %s, which has a lower or equal rank', (current, next) => {
    expect(canAdvanceRecipientStatus(current, next)).toBe(false);
  });

  it.each<RecipientStatus>(['pending', 'accepted', 'delivered', 'bounced', 'rejected'])(
    'keeps suppressed and rejected final against %s',
    (next) => {
      expect(canAdvanceRecipientStatus('suppressed', next)).toBe(false);
      expect(canAdvanceRecipientStatus('rejected', next)).toBe(false);
    },
  );
});
