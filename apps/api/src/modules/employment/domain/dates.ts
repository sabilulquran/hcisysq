// Asia/Jakarta business dates as ISO `YYYY-MM-DD` strings. All employment
// ranges are inclusive on both ends (spec §7.1).

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type IsoDate = string;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function toUtc(value: IsoDate): Date {
  if (!isIsoDate(value)) throw new Error(`Invalid ISO date: ${value}`);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtc(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function addDays(value: IsoDate, days: number): IsoDate {
  const date = toUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

export function addMonths(value: IsoDate, months: number): IsoDate {
  const date = toUtc(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return fromUtc(date);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

/** ISO dates compare correctly as strings; null bounds are open-ended. */
export function compareDates(left: IsoDate, right: IsoDate): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isWithin(date: IsoDate, from: IsoDate | null, to: IsoDate | null): boolean {
  return (from === null || from <= date) && (to === null || date <= to);
}

export function rangesOverlap(
  aFrom: IsoDate | null,
  aTo: IsoDate | null,
  bFrom: IsoDate | null,
  bTo: IsoDate | null,
): boolean {
  const startsBeforeOtherEnds = aFrom === null || bTo === null || aFrom <= bTo;
  const endsAfterOtherStarts = aTo === null || bFrom === null || bFrom <= aTo;
  return startsBeforeOtherEnds && endsAfterOtherStarts;
}

export function lastDayOfMonth(year: number, month: number): IsoDate {
  return fromUtc(new Date(Date.UTC(year, month, 0)));
}
