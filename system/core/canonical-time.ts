const UTC_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

export function isCanonicalUtcDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = UTC_DATE.exec(value);
  return Boolean(match && validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])));
}

export function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = UTC_TIMESTAMP.exec(value);
  return Boolean(
    match
    && validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
    && Number(match[4]) <= 23
    && Number(match[5]) <= 59
    && Number(match[6]) <= 59
    && !Number.isNaN(Date.parse(value)),
  );
}
