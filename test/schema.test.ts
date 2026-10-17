import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DB } from "node:sqlite";

// vite가 node:sqlite를 해석하지 못하므로 require로 로드한다.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => DB };

const sql = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
const REQUIRED = ["users","user_sessions","products","product_versions","prices","subscriptions","subscription_items","invoices","payments","refunds","usage_records","usage_aggregates","containers","container_assignments","container_metrics","cpu_addons","databases","storage_buckets","worker_services","ai_models","ai_model_prices","ai_usage_records","domains","deployment_jobs","queue_jobs","affiliate_users","affiliate_referrals","affiliate_commissions","affiliate_payouts","webhook_events","audit_logs","admin_settings","notifications"];

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

describe("D1 스키마(SQLite로 검증)", () => {
  it("명령서의 필수 테이블 33개가 모두 존재", () => {
    const db = fresh();
    const names = (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of REQUIRED) expect(names, t).toContain(t);
  });
  it("외래 키 위반 거부", () => {
    const db = fresh();
    expect(() => db.prepare("insert into subscriptions(id,customer_id,product_id,price_version_id) values('s','nouser','noprod','noprice')").run()).toThrow();
  });
  it("웹훅 이벤트 ID 중복 거부(멱등성)", () => {
    const db = fresh();
    const ins = () => db.prepare("insert into webhook_events(id,type,payload_json) values('evt_1','invoice.paid','{}')").run();
    ins();
    expect(ins).toThrow();
  });
  it("가격 버전 유니크 + 자기 추천 CHECK", () => {
    const db = fresh();
    db.exec("insert into products(id,kind,name_ko) values('p','ccs','x')");
    db.exec("insert into prices(id,product_id,version,monthly_micro,rates_json) values('pr1','p',1,1000000,'{}')");
    expect(() => db.exec("insert into prices(id,product_id,version,monthly_micro) values('pr2','p',1,2000000)")).toThrow();
  });
  it("월 단위 외 청구 주기 거부, 음수 사용량 거부", () => {
    const db = fresh();
    db.exec("insert into users(id,email,password_hash) values('u','a@b.c','h')");
    db.exec("insert into products(id,kind,name_ko) values('p','ccs','x')");
    db.exec("insert into prices(id,product_id,version,monthly_micro) values('pr','p',1,1000000)");
    expect(() => db.exec("insert into subscriptions(id,customer_id,product_id,price_version_id,billing_interval) values('s','u','p','pr','year')")).toThrow();
    expect(() => db.exec("insert into subscriptions(id,customer_id,product_id,price_version_id,usage_amount_micro) values('s','u','p','pr',-1)")).toThrow();
  });
  it("백업은 암호화 필수, Cloudage 구독당 버킷 1개", () => {
    const db = fresh();
    db.exec("insert into users(id,email,password_hash) values('u','a@b.c','h')");
    db.exec("insert into products(id,kind,name_ko) values('p','cloudb','x')");
    db.exec("insert into prices(id,product_id,version,monthly_micro) values('pr','p',1,1000000)");
    db.exec("insert into subscriptions(id,customer_id,product_id,price_version_id) values('s','u','p','pr')");
    db.exec("insert into databases(id,subscription_id,customer_id,engine,provider) values('d','s','u','mariadb','cloudb_container')");
    expect(() => db.exec("insert into backups(id,database_id,kind,r2_key,encrypted) values('b','d','full','k',0)")).toThrow();
    db.exec("insert into storage_buckets(id,subscription_id,customer_id,r2_bucket_name) values('sb','s','u','bk1')");
    expect(() => db.exec("insert into storage_buckets(id,subscription_id,customer_id,r2_bucket_name) values('sb2','s','u','bk2')")).toThrow();
  });
});
