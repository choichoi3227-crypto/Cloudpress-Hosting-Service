/** Cloudflare API v4 최소 클라이언트. 토큰은 서버 비밀로만 보관하고 로그·오류 메시지에 넣지 않는다. */
export interface FetchResponse { status: number; json(): Promise<unknown> }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponse>

export class CfApiError extends Error {
  constructor(public status: number, public codes: number[], message: string) { super(message); }
  /** 429·5xx 는 재시도 가능, 4xx 는 요청 자체의 문제. */
  get retryable() { return this.status === 429 || this.status >= 500; }
}

export interface CfEnvelope<T> { success: boolean; errors?: { code: number; message: string }[]; result?: T }

export class CfClient {
  constructor(private o: { token: string; accountId: string; fetch?: FetchLike; baseUrl?: string }) {
    if (!o.token) throw new Error("CLOUDFLARE_API_TOKEN 이 설정되지 않음");
    if (!/^[0-9a-f]{32}$/i.test(o.accountId)) throw new Error("accountId 형식 오류");
  }
  get accountId() { return this.o.accountId; }

  async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; result: T }> {
    const f: FetchLike = this.o.fetch ?? ((u, i) => fetch(u, i) as Promise<FetchResponse>);
    const res = await f(`${this.o.baseUrl ?? "https://api.cloudflare.com/client/v4"}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.o.token}`, "Content-Type": "application/json", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let env: CfEnvelope<T> | null = null;
    try { env = (await res.json()) as CfEnvelope<T>; } catch { /* 본문 없음 */ }
    if (res.status >= 400 || !env || env.success === false) {
      const errs = env?.errors ?? [];
      throw new CfApiError(res.status, errs.map((e) => e.code), errs.map((e) => e.message).join("; ") || `HTTP ${res.status}`);
    }
    return { status: res.status, result: env.result as T };
  }
}
