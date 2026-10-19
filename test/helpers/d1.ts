import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { DatabaseSync as DB } from "node:sqlite";
import type { D1Like, D1Stmt } from "../../src/lib/db";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => DB };
export const MIGRATIONS = ["0001_init.sql", "0002_engines_rail_optimizer.sql", "0003_storage_recycling.sql", "0004_domains_zones.sql"];
export const readMigration = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");

class Stmt implements D1Stmt {
  constructor(private db: DB, private sql: string, private params: unknown[] = []) {}
  bind(...v: unknown[]) { return new Stmt(this.db, this.sql, v.map((x) => (x === undefined ? null : x))); }
  async first<T>() { const r = this.db.prepare(this.sql).get(...(this.params as never[])); return r ? ({ ...r } as T) : null; }
  async run() { const r = this.db.prepare(this.sql).run(...(this.params as never[])); return { meta: { changes: Number(r.changes) } }; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...(this.params as never[])).map((r) => ({ ...r }) as T) }; }
}

/** 테스트용 D1 호환 어댑터(SQLite). batch 는 트랜잭션으로 원자성을 보장한다. */
export function makeDb(): { db: D1Like; raw: DB } {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of MIGRATIONS) { raw.exec("BEGIN"); raw.exec(readMigration(f)); raw.exec("COMMIT"); } // D1 도 마이그레이션을 트랜잭션으로 적용
  const db: D1Like = {
    prepare: (sql) => new Stmt(raw, sql),
    async batch(stmts) {
      raw.exec("BEGIN");
      try { const out = []; for (const s of stmts) out.push(await s.run()); raw.exec("COMMIT"); return out; }
      catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
  };
  return { db, raw };
}

/** 구독 시나리오 시드: 사용자, 상품, 가격 버전, incomplete 구독(Stripe ID 미연결). */
export function seedSubscription(raw: DB, opts: { subId?: string; stripeSub?: string | null } = {}) {
  const subId = opts.subId ?? "sub_1";
  raw.exec("INSERT OR IGNORE INTO users(id,email,password_hash) VALUES('u1','u1@example.com','x')");
  raw.exec("INSERT OR IGNORE INTO products(id,kind,name_ko) VALUES('ccs-basic','ccs','CCS Basic')");
  raw.exec("INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro) VALUES('price_v1','ccs-basic',1,12990000)");
  raw.prepare("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id,stripe_subscription_id) VALUES(?,?,?,?,?)").run(subId, "u1", "ccs-basic", "price_v1", opts.stripeSub ?? null);
  return subId;
}
