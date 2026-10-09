import type { Clock } from "./clock.js";
import type { RetryPolicy } from "./domain.js";
import { ProviderError } from "./provider.js";

export class RequestTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";

  constructor() {
    super("Provider request timed out");
    this.name = "RequestTimeoutError";
  }
}

export class RetryAfterExceedsLimitError extends Error {
  readonly code = "RETRY_AFTER_EXCEEDS_LIMIT";

  constructor(readonly retryNotBefore: string) {
    super("Provider Retry-After exceeds the configured wait limit");
    this.name = "RetryAfterExceedsLimitError";
  }
}

export class RetryAfterUnrepresentableError extends Error {
  readonly code = "RETRY_AFTER_UNREPRESENTABLE";

  constructor() {
    super("Provider Retry-After cannot be represented as a date");
    this.name = "RetryAfterUnrepresentableError";
  }
}

export class RetryExhaustedError extends Error {
  readonly code = "RETRIES_EXHAUSTED";

  constructor(readonly lastError: Error) {
    super("Provider retries exhausted", { cause: lastError });
    this.name = "RetryExhaustedError";
  }
}

export function retryAfterMs(value: string | undefined, now: Date): number | null {
  if (!value) return null;
  const header = value.trim();
  if (!header) return null;
  if (/^\d+$/.test(header)) {
    const delay = Number(header) * 1000;
    const retryAt = now.getTime() + delay;
    if (!Number.isFinite(delay) || !isRepresentableDate(retryAt)) throw new RetryAfterUnrepresentableError();
    return delay;
  }
  const date = parseHttpDate(header, now);
  return date === null ? null : Math.max(0, date - now.getTime());
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof RequestTimeoutError) return true;
  if (error instanceof ProviderError) return [408, 429, 500, 502, 503, 504].includes(error.status);
  return error instanceof TypeError;
}

export async function waitBeforeRetry(error: unknown, attempt: number, policy: RetryPolicy, clock: Clock): Promise<void> {
  const providerError = error instanceof ProviderError ? error : null;
  const now = clock.now();
  const requestedDelay = providerError?.status === 429
    ? retryAfterMs(providerError.retryAfter, now)
    : null;
  const delay = requestedDelay ?? Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempt - 1), policy.maxRetryDelayMs);

  if (delay > policy.maxRetryDelayMs) {
    const retryAt = now.getTime() + delay;
    if (!isRepresentableDate(retryAt)) throw new RetryAfterUnrepresentableError();
    throw new RetryAfterExceedsLimitError(new Date(retryAt).toISOString());
  }
  await clock.sleep(delay);
}

function parseHttpDate(value: string, now: Date): number | null {
  const imfFixdate = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (imfFixdate) {
    return httpDateTimestamp(
      imfFixdate[1]!, Number(imfFixdate[2]), imfFixdate[3]!, Number(imfFixdate[4]),
      Number(imfFixdate[5]), Number(imfFixdate[6]), Number(imfFixdate[7]),
    );
  }

  const rfc850 = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (rfc850) {
    return rfc850DateTimestamp(
      rfc850[1]!, Number(rfc850[2]), rfc850[3]!, Number(rfc850[4]),
      Number(rfc850[5]), Number(rfc850[6]), Number(rfc850[7]), now,
    );
  }

  const asctime = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( {1}\d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  if (asctime) {
    return httpDateTimestamp(
      asctime[1]!, Number(asctime[3]!.trim()), asctime[2]!, Number(asctime[7]),
      Number(asctime[4]), Number(asctime[5]), Number(asctime[6]),
    );
  }

  return null;
}

function rfc850DateTimestamp(
  weekday: string,
  day: number,
  monthName: string,
  twoDigitYear: number,
  hour: number,
  minute: number,
  second: number,
  now: Date,
): number | null {
  const currentYear = now.getUTCFullYear();
  let year = Math.floor(currentYear / 100) * 100 + twoDigitYear;
  const candidate = httpDateTimestamp(weekday, day, monthName, year, hour, minute, second, false);
  if (candidate === null) return null;
  const fiftyYearsFromNow = new Date(now.getTime());
  fiftyYearsFromNow.setUTCFullYear(currentYear + 50);
  if (candidate > fiftyYearsFromNow.getTime()) year -= 100;
  return httpDateTimestamp(weekday, day, monthName, year, hour, minute, second);
}

function httpDateTimestamp(
  weekday: string,
  day: number,
  monthName: string,
  year: number,
  hour: number,
  minute: number,
  second: number,
  checkWeekday = true,
): number | null {
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(monthName);
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday.slice(0, 3));
  if (month < 0 || weekdayIndex < 0 || hour > 23 || minute > 59 || second > 60) return null;

  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute
    || (checkWeekday && date.getUTCDay() !== weekdayIndex)) {
    return null;
  }
  return date.getTime() + (second === 60 ? 1000 : 0);
}

function isRepresentableDate(timestamp: number): boolean {
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15;
}
