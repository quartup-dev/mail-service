import type { Clock } from '../../src/application/ports/clock';

export class FakeClock implements Clock {
  private current: Date;

  constructor(start = new Date('2026-10-29T10:00:00.000Z')) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
