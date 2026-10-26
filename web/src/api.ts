// Calls to the Express API. The session cookie is set by /api/login and sent
// automatically with every request (same origin), so nothing here stores it.

export type User = { username: string; role: "user" | "admin" };
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type Source = { manual: string; docCode: string; page: number; section: string | null; url: string };
export type AgentReply = { reply: string; sources: Source[] };

/** An API error with a message meant for the user */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(data.error ?? "Something went wrong. Please try again.", response.status);
  }
  return data as T;
}

/** The logged-in user, or null when there's no valid session */
export async function getMe(): Promise<User | null> {
  try {
    return await request<User>("GET", "/api/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export const login = (username: string, password: string) =>
  request<User>("POST", "/api/login", { username, password });

export const logout = () => request<{ ok: true }>("POST", "/api/logout");

/** Sends the conversation (newest last); the server accepts at most 30 messages */
export const sendChat = (messages: ChatMessage[]) =>
  request<AgentReply>("POST", "/api/chat", { messages: messages.slice(-30) });
