/** Cloudflare D1 의 최소 호환 인터페이스. 테스트에서는 SQLite 어댑터로 대체한다. */
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
  /** 원자적 일괄 실행(전부 성공 또는 전부 롤백). */
  batch(stmts: D1Stmt[]): Promise<unknown[]>;
}
export interface QueueLike<T = unknown> { send(message: T): Promise<void> }

export const nowIso = (ms: number = Date.now()) => new Date(ms).toISOString();
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
