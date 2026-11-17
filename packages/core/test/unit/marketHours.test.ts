import { isNseOpen } from '../../src';

describe('isNseOpen (09:15–15:30 IST, Mon–Fri)', () => {
  const ist = (iso: string) => new Date(`${iso}+05:30`);

  it.each([
    ['2026-11-17T09:15:00', true], // Tuesday, opening bell
    ['2026-11-17T12:00:00', true],
    ['2026-11-17T15:29:59', true],
    ['2026-11-17T15:30:00', false], // closing bell
    ['2026-11-17T09:14:59', false],
    ['2026-11-17T20:00:00', false],
    ['2026-11-21T11:00:00', false], // Saturday
    ['2026-11-22T11:00:00', false], // Sunday
  ])('%s IST -> %s', (when, open) => {
    expect(isNseOpen(ist(when))).toBe(open);
  });
});
