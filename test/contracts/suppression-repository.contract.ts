import { beforeEach, describe, expect, it } from 'vitest';
import type { SuppressionRepository } from '../../src/application/ports/suppression-repository';
import type { FakeClock } from '../support/fake-clock';

export interface SuppressionRepositoryContext {
  repository: SuppressionRepository;
  clock: FakeClock;
}

// Batería común a todas las implementaciones de SuppressionRepository (en memoria y Drizzle)
export function describeSuppressionRepositoryContract(
  name: string,
  createContext: () => Promise<SuppressionRepositoryContext>,
): void {
  describe(`${name} (SuppressionRepository contract)`, () => {
    let repository: SuppressionRepository;
    let clock: FakeClock;

    beforeEach(async () => {
      ({ repository, clock } = await createContext());
    });

    it('findSuppressed returns the suppressed addresses in lowercase, regardless of case', async () => {
      await repository.add('Rebote@Dominio.com', 'bounce', 'mailgun');

      const suppressed = await repository.findSuppressed([
        'rebote@dominio.com',
        'REBOTE@DOMINIO.COM',
        'ok@dominio.com',
      ]);

      expect(suppressed).toEqual(new Set(['rebote@dominio.com']));
    });

    it('add is idempotent and keeps the first entry', async () => {
      await repository.add('rebote@dominio.com', 'bounce', 'mailgun');
      clock.advance(1_000);
      await repository.add('rebote@dominio.com', 'complaint', 'ses');

      expect(await repository.list()).toEqual([
        {
          email: 'rebote@dominio.com',
          reason: 'bounce',
          source: 'mailgun',
          createdAt: new Date(clock.now().getTime() - 1_000),
        },
      ]);
    });

    it('remove lifts the suppression regardless of case', async () => {
      await repository.add('rebote@dominio.com', 'bounce', 'mailgun');

      await repository.remove('Rebote@Dominio.com');

      expect(await repository.findSuppressed(['rebote@dominio.com'])).toEqual(new Set());
    });

    it('list filters by reason and paginates in creation order', async () => {
      await repository.add('a@dominio.com', 'bounce', 'mailgun');
      clock.advance(1_000);
      await repository.add('b@dominio.com', 'manual', 'cli');
      clock.advance(1_000);
      await repository.add('c@dominio.com', 'bounce', 'ses');
      clock.advance(1_000);
      await repository.add('d@dominio.com', 'bounce', 'ses');

      const emailsOf = (entries: Array<{ email: string }>) => entries.map((entry) => entry.email);

      expect(emailsOf(await repository.list({ reason: 'bounce' }))).toEqual([
        'a@dominio.com',
        'c@dominio.com',
        'd@dominio.com',
      ]);
      expect(emailsOf(await repository.list({ reason: 'bounce', limit: 1, offset: 1 }))).toEqual([
        'c@dominio.com',
      ]);
    });
  });
}
