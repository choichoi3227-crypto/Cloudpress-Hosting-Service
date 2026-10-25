import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync as DB } from "node:sqlite";
import { readMigration } from "./helpers/d1";
import { makeDb } from "./helpers/d1";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => DB };

describe("마이그레이션 0002 (데이터 보존 + 새 제약)", () => {
  it("기존 데이터를 보존하며 적용된다(supabase_pg → cloudb_pg, FK 유지)", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(readMigration("0001_init.sql"));
    raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u','a@b.co','h')");
    raw.exec("INSERT INTO products(id,kind,name_ko) VALUES('pg-micro','supabase_pg','x'),('cloudb-mariadb','cloudb','y')");
    raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('pr1','pg-micro',1,1),('pr2','cloudb-mariadb',1,1)");
    raw.exec("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id) VALUES('s1','u','pg-micro','pr1'),('s2','u','cloudb-mariadb','pr2')");
    raw.exec("INSERT INTO databases(id,subscription_id,customer_id,engine,provider) VALUES('d1','s1','u','postgres','supabase'),('d2','s2','u','mariadb','cloudb_container')");
    raw.exec("INSERT INTO backups(id,database_id,kind,r2_key) VALUES('b1','d2','full','k1')");
    raw.exec("INSERT INTO payments(id,customer_id,amount_micro,status) VALUES('p1','u',5,'succeeded')");
    raw.exec("BEGIN"); raw.exec(readMigration("0002_engines_rail_optimizer.sql")); raw.exec("COMMIT");
    expect(raw.prepare("select kind from products where id='pg-micro'").get()).toMatchObject({ kind: "cloudb_pg" });
    expect((raw.prepare("select count(*) c from databases").get() as { c: number }).c).toBe(2);
    expect((raw.prepare("select count(*) c from backups").get() as { c: number }).c).toBe(1);
    expect(raw.prepare("select rail from payments").get()).toMatchObject({ rail: "stripe" });
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]); // 고아 행 없음
  });
  it("엔진-제공자 조합 일관성: 허용 조합만 저장 가능", () => {
    const { raw } = makeDb();
    raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u','a@b.co','h')");
    raw.exec("INSERT INTO products(id,kind,name_ko) VALUES('p','cloudb_pg','x')");
    raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('pr','p',1,1)");
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9]) raw.exec(`INSERT INTO subscriptions(id,customer_id,product_id,price_version_id) VALUES('s${i}','u','p','pr')`);
    const ins = (i: number, engine: string, provider: string, standby: string | null = null) =>
      () => raw.prepare("INSERT INTO databases(id,subscription_id,customer_id,engine,provider,standby_provider) VALUES(?,?,?,?,?,?)").run(`d${i}`, `s${i}`, "u", engine, provider, standby);
    expect(ins(1, "postgres", "neon", "supabase")).not.toThrow();
    expect(ins(2, "postgres", "supabase", "neon")).not.toThrow();
    expect(ins(3, "sqlite", "d1")).not.toThrow();
    expect(ins(4, "mysql", "cloudb_container")).not.toThrow();
    expect(ins(5, "postgres", "cloudb_container")).toThrow(); // PG 는 Neon/Supabase 만
    expect(ins(6, "sqlite", "neon")).toThrow();
    expect(ins(7, "mysql", "neon")).toThrow();
    expect(ins(8, "postgres", "neon", "neon")).toThrow(); // 보조는 다른 제공자여야 함
    expect(ins(9, "mariadb", "cloudb_container", "supabase")).toThrow(); // 보조는 PG 전용
  });
  it("결제 채널 CHECK, 열린 권고는 (자원,종류)당 1개", () => {
    const { raw } = makeDb();
    raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u','a@b.co','h')");
    expect(() => raw.exec("INSERT INTO payments(id,customer_id,amount_micro,status,rail) VALUES('p','u',1,'succeeded','paypal')")).toThrow();
    expect(() => raw.exec("INSERT INTO payments(id,customer_id,amount_micro,status,rail) VALUES('p','u',1,'succeeded','x402')")).not.toThrow();
    const reco = (id: string, status = "open") => () => raw.exec(`INSERT INTO resource_recommendations(id,resource_type,resource_id,kind,payload_json,status) VALUES('${id}','container','c1','idle','{}','${status}')`);
    expect(reco("r1")).not.toThrow();
    expect(reco("r2")).toThrow();
    expect(reco("r3", "dismissed")).not.toThrow();
  });
  it("0003: 약정 기본 10GB, 대여 제약, 일별 사용량 연쇄 삭제", () => {
    const { raw } = makeDb();
    raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u','a@b.co','h')");
    raw.exec("INSERT INTO products(id,kind,name_ko) VALUES('p','cloudage','x')");
    raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('pr','p',1,1)");
    raw.exec("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id) VALUES('s1','u','p','pr'),('s2','u','p','pr')");
    raw.exec("INSERT INTO storage_buckets(id,subscription_id,customer_id,r2_bucket_name) VALUES('b1','s1','u','n1'),('b2','s2','u','n2')");
    expect(raw.prepare("select entitlement_bytes e, policy_json p from storage_buckets where id='b1'").get()).toMatchObject({ e: 10_000_000_000, p: "{}" });
    expect(() => raw.exec("INSERT INTO storage_loans(id,lender_bucket_id,borrower_bucket_id,bytes,scope) VALUES('l1','b1','b1',1,'customer')")).toThrow();
    expect(() => raw.exec("INSERT INTO storage_loans(id,lender_bucket_id,borrower_bucket_id,bytes,scope) VALUES('l1','b1','b2',0,'customer')")).toThrow();
    expect(() => raw.exec("INSERT INTO storage_loans(id,lender_bucket_id,borrower_bucket_id,bytes,scope) VALUES('l1','b1','b2',256,'galaxy')")).toThrow();
    expect(() => raw.exec("INSERT INTO storage_loans(id,lender_bucket_id,borrower_bucket_id,bytes,scope) VALUES('l1','b1','b2',256,'customer')")).not.toThrow();
    raw.exec("INSERT INTO storage_usage_daily(bucket_id,day,logical_peak_bytes,logical_end_bytes,physical_end_bytes) VALUES('b1','2026-10-18',5,5,3)");
    expect(() => raw.exec("DELETE FROM storage_buckets WHERE id='b1'")).toThrow(); // 대여 원장이 참조 중이면 삭제 불가
  });
});
