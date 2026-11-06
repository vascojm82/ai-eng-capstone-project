// Usage limits that protect the OpenAI bill:
//   - each user: QUESTIONS_PER_USER_PER_HOUR questions in any 60 minutes
//   - each phone caller: QUESTIONS_PER_CALLER_PER_HOUR questions in any 60 minutes
//   - the whole app: QUESTIONS_PER_DAY questions per day (UTC), web and phone together
//   - each IP address: LOGIN_ATTEMPTS login attempts (successful or not) per 15 minutes
//   - each MCP client (external agent): its hourly limit (default MCP_CALLS_PER_CLIENT_PER_HOUR)
//     tool calls in any 60 minutes, and all of them together MCP_CALLS_PER_DAY per day (UTC),
//     counted apart from the web and phone questions so agents can't use up the app's limit
//   - each IP address: MCP_AUTH_FAILURES requests with a wrong MCP key per 15 minutes
//
// Counts are kept in this process's memory: they reset when the server
// restarts, and each server instance counts on its own. That's enough for a
// single small deployment; a shared store (the database) would be the next step.

export const QUESTIONS_PER_USER_PER_HOUR = 20;
export const QUESTIONS_PER_CALLER_PER_HOUR = 20;
export const QUESTIONS_PER_DAY = 300;
export const MCP_CALLS_PER_CLIENT_PER_HOUR = 60;
export const MCP_CALLS_PER_DAY = 1000;
const MCP_AUTH_FAILURES = 10;
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

  /** Records an event and returns true, or returns false when the key is over its limit (`limit` overrides the window's own) */
  take(key: string, now = Date.now(), limit = this.limit): boolean {
    const recent = (this.events.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= limit) {
      this.events.set(key, recent);
      return false;
    }
    recent.push(now);
    this.events.set(key, recent);
    return true;
  }

  /** Whether the key is at its limit, without recording an event */
  isFull(key: string, now = Date.now()): boolean {
    return (this.events.get(key) ?? []).filter((t) => now - t < this.windowMs).length >= this.limit;
  }

  /** Seconds until the oldest event in the window expires */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const oldest = (this.events.get(key) ?? [])[0];
    return oldest === undefined ? 0 : Math.ceil((oldest + this.windowMs - now) / 1000);
  }
}

const perUser = new SlidingWindow(QUESTIONS_PER_USER_PER_HOUR, HOUR_MS);
const perCaller = new SlidingWindow(QUESTIONS_PER_CALLER_PER_HOUR, HOUR_MS);
const loginsPerIp = new SlidingWindow(LOGIN_ATTEMPTS, LOGIN_WINDOW_MS);
const perMcpClient = new SlidingWindow(MCP_CALLS_PER_CLIENT_PER_HOUR, HOUR_MS);
const mcpAuthFailuresPerIp = new SlidingWindow(MCP_AUTH_FAILURES, LOGIN_WINDOW_MS);
let mcpDay = "";
let mcpCallsToday = 0;
let day = "";
let questionsToday = 0;

export type LimitResult = { ok: true } | { ok: false; error: string; retryAfterSeconds: number };

/** Counts one question against `window` for `key` and against the app's daily limit */
function take(window: SlidingWindow, key: string, overLimitError: string, now: Date): LimitResult {
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
  if (!window.take(key, now.getTime())) {
    return { ok: false, error: overLimitError, retryAfterSeconds: window.retryAfterSeconds(key, now.getTime()) };
  }
  questionsToday++;
  return { ok: true };
}

/** Counts one question for this user; refuses it when the user or the whole app is over the limit */
export function takeQuestion(username: string, now = new Date()): LimitResult {
  const error = `You've reached the limit of ${QUESTIONS_PER_USER_PER_HOUR} questions per hour. Please try again later.`;
  return take(perUser, username, error, now);
}

/** Counts one phone question for this caller (their phone number); refuses it when the caller or the whole app is over the limit */
export function takeVoiceQuestion(caller: string, now = new Date()): LimitResult {
  const error = `You've reached the limit of ${QUESTIONS_PER_CALLER_PER_HOUR} questions per hour. Please call again later.`;
  return take(perCaller, caller, error, now);
}

/** Counts one MCP tool call for this client; refuses it when the client or all MCP clients together are over their limit */
export function takeMcpCall(clientId: number, hourlyLimit: number | null, now = new Date()): LimitResult {
  const today = now.toISOString().slice(0, 10);
  if (today !== mcpDay) {
    mcpDay = today;
    mcpCallsToday = 0;
  }
  if (mcpCallsToday >= MCP_CALLS_PER_DAY) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return {
      ok: false,
      error: "The manual tools have reached their daily limit. Please try again tomorrow.",
      retryAfterSeconds: Math.ceil((midnight - now.getTime()) / 1000),
    };
  }
  const limit = hourlyLimit ?? MCP_CALLS_PER_CLIENT_PER_HOUR;
  const key = String(clientId);
  if (!perMcpClient.take(key, now.getTime(), limit)) {
    return {
      ok: false,
      error: `This key has reached its limit of ${limit} tool calls per hour.`,
      retryAfterSeconds: perMcpClient.retryAfterSeconds(key, now.getTime()),
    };
  }
  mcpCallsToday++;
  return { ok: true };
}

/** Counts one request with a wrong MCP key from this IP address; false once there were too many */
export function takeMcpAuthFailure(ip: string): boolean {
  return mcpAuthFailuresPerIp.take(ip);
}

/** Whether this IP address has sent too many wrong MCP keys lately (without counting another) */
export function tooManyMcpAuthFailures(ip: string): boolean {
  return mcpAuthFailuresPerIp.isFull(ip);
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
