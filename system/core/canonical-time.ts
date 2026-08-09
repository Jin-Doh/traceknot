const UTC_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

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

function timestampFraction(value: string): string {
  return UTC_TIMESTAMP.exec(value)?.[7] ?? "";
}

export function compareCanonicalUtcTimestamps(left: string, right: string): number {
  if (!isCanonicalUtcTimestamp(left) || !isCanonicalUtcTimestamp(right)) throw new Error("invalid canonical UTC timestamp");
  const leftWhole = left.slice(0, 19);
  const rightWhole = right.slice(0, 19);
  if (leftWhole !== rightWhole) return leftWhole < rightWhole ? -1 : 1;
  const leftFraction = timestampFraction(left);
  const rightFraction = timestampFraction(right);
  const width = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(width, "0");
  const normalizedRight = rightFraction.padEnd(width, "0");
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
}

export function addMillisecondsToCanonicalUtcTimestamp(value: string, duration: number): string {
  if (!isCanonicalUtcTimestamp(value) || !Number.isSafeInteger(duration)) throw new Error("invalid canonical UTC timestamp arithmetic");
  const fraction = timestampFraction(value);
  const milliseconds = fraction.padEnd(3, "0").slice(0, 3);
  const subMilliseconds = fraction.slice(3);
  const instant = `${value.slice(0, 19)}.${milliseconds}Z`;
  const shifted = new Date(Date.parse(instant) + duration).toISOString();
  return subMilliseconds ? `${shifted.slice(0, -1)}${subMilliseconds}Z` : shifted;
}
