/**
 * A non-2xx response.
 *
 * The status travels with the message because callers need to tell two very
 * different situations apart: `402` means "your plan does not include this",
 * which is information the user can act on by upgrading, while anything else
 * is a genuine fault. Collapsing them into a bare `Error` is what made a
 * plan-gated panel look like the workspace had broken.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      body?.error?.message ?? "Request failed",
      response.status,
    );
  return body as T;
}
