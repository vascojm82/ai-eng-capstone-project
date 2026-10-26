// Usage limits that protect the OpenAI bill:
//   - each user: QUESTIONS_PER_USER_PER_HOUR questions in any 60 minutes
//   - the whole app: QUESTIONS_PER_DAY questions per day (UTC)
//   - each IP address: LOGIN_ATTEMPTS login attempts (successful or not) per 15 minutes
//
// Counts are kept in this process's memory: they reset when the server
// restarts, and each server instance counts on its own. That's enough for a
// single small deployment; a shared store (the database) would be the next step.

export const QUESTIONS_PER_USER_PER_HOUR = 20;
export const QUESTIONS_PER_DAY = 300;
const LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Timestamps of recent events per key, for "N in the last window" limits */
class SlidingWindow {
  private events = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records an event and returns true, or returns false when the key is over its limit */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.events.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.events.set(key, recent);
      return false;
    }
    recent.push(now);
    this.events.set(key, recent);
    return true;
  }

  /** Seconds until the oldest event in the window expires */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const oldest = (this.events.get(key) ?? [])[0];
    return oldest === undefined ? 0 : Math.ceil((oldest + this.windowMs - now) / 1000);
  }
}

const perUser = new SlidingWindow(QUESTIONS_PER_USER_PER_HOUR, HOUR_MS);
const loginsPerIp = new SlidingWindow(LOGIN_ATTEMPTS, LOGIN_WINDOW_MS);
let day = "";
let questionsToday = 0;

export type LimitResult = { ok: true } | { ok: false; error: string; retryAfterSeconds: number };

/** Counts one question for this user; refuses it when the user or the whole app is over the limit */
export function takeQuestion(username: string, now = new Date()): LimitResult {
  const today = now.toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    questionsToday = 0;
  }
  if (questionsToday >= QUESTIONS_PER_DAY) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return {
      ok: false,
      error: "The assistant has reached its daily limit of questions. Please try again tomorrow.",
      retryAfterSeconds: Math.ceil((midnight - now.getTime()) / 1000),
    };
  }
  if (!perUser.take(username, now.getTime())) {
    return {
      ok: false,
      error: `You've reached the limit of ${QUESTIONS_PER_USER_PER_HOUR} questions per hour. Please try again later.`,
      retryAfterSeconds: perUser.retryAfterSeconds(username, now.getTime()),
    };
  }
  questionsToday++;
  return { ok: true };
}

/** Counts one login attempt from this IP address; refuses it when there were too many */
export function takeLoginAttempt(ip: string): LimitResult {
  if (loginsPerIp.take(ip)) return { ok: true };
  return {
    ok: false,
    error: "Too many login attempts. Please wait a few minutes and try again.",
    retryAfterSeconds: loginsPerIp.retryAfterSeconds(ip),
  };
}
