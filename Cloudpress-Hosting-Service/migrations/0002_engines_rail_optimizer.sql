-- 0002: ClouDB 다중 엔진(MariaDB/MySQL/PostgreSQL/SQLite), 결제 채널(rail), 최적화 권고 테이블.
-- SQLite/D1 은 CHECK 를 ALTER 할 수 없으므로 테이블을 재생성한다.
-- 순서: 임시 복사 → 원본 삭제 → 새 테이블 생성 → 복사 삽입. 외래 키는 커밋 시점까지 지연되며,
-- 부모 행을 다시 삽입하면 지연된 위반이 해소된다(원본 삭제 전에 새 테이블을 채우면 해소되지 않음).
PRAGMA defer_foreign_keys = ON;

CREATE TABLE products_tmp AS SELECT * FROM products;
DROP TABLE products;
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ccs','cloudb','cloudb_sqlite','cloudb_pg','cloudage','csw','wordpress','cas','cpu_upgrade')),
  name_ko TEXT NOT NULL,
  instance_type TEXT,
  target_vcpu REAL,
  included_active_hours INTEGER,
  included_storage_gb INTEGER,
  on_sale INTEGER NOT NULL DEFAULT 1 CHECK (on_sale IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO products SELECT id, CASE kind WHEN 'supabase_pg' THEN 'cloudb_pg' ELSE kind END, name_ko, instance_type, target_vcpu, included_active_hours, included_storage_gb, on_sale, created_at FROM products_tmp;
DROP TABLE products_tmp;

CREATE TABLE databases_tmp AS SELECT * FROM databases;
DROP TABLE databases;
CREATE TABLE databases (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  engine TEXT NOT NULL CHECK (engine IN ('mariadb','mysql','postgres','sqlite')),
  provider TEXT NOT NULL CHECK (provider IN ('cloudb_container','neon','supabase','d1')),
  container_id TEXT REFERENCES containers(id),
  external_project_ref TEXT,
  standby_provider TEXT,
  standby_ref TEXT,
  replication_lag_ms INTEGER,
  ha_tier INTEGER NOT NULL DEFAULT 0 CHECK (ha_tier IN (0,1)),
  state TEXT NOT NULL DEFAULT 'provisioning' CHECK (state IN ('provisioning','ready','degraded','failed','deleting','deleted')),
  secret_ref TEXT,
  storage_limit_gb INTEGER NOT NULL DEFAULT 2,
  last_backup_at TEXT,
  last_restore_test_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (subscription_id),
  -- 엔진과 제공자의 조합 일관성: 허용되지 않는 조합은 저장할 수 없다.
  CHECK ((engine IN ('mariadb','mysql') AND provider = 'cloudb_container')
      OR (engine = 'postgres' AND provider IN ('neon','supabase'))
      OR (engine = 'sqlite' AND provider = 'd1')),
  -- 보조(standby)는 PostgreSQL 에서 주 제공자와 다른 제공자여야 한다(교차 제공자 이중화).
  CHECK (standby_provider IS NULL OR (engine = 'postgres' AND standby_provider IN ('neon','supabase') AND standby_provider <> provider))
);
INSERT INTO databases(id,subscription_id,customer_id,engine,provider,container_id,external_project_ref,ha_tier,state,secret_ref,storage_limit_gb,last_backup_at,last_restore_test_at,created_at)
  SELECT id,subscription_id,customer_id,engine,provider,container_id,external_project_ref,ha_tier,state,secret_ref,storage_limit_gb,last_backup_at,last_restore_test_at,created_at FROM databases_tmp;
DROP TABLE databases_tmp;

-- 결제 채널: 현재는 stripe 만 사용. x402(Monetization Gateway)는 정식 지원 확인 후 별도 원장으로 연결한다.
ALTER TABLE payments ADD COLUMN rail TEXT NOT NULL DEFAULT 'stripe' CHECK (rail IN ('stripe','x402'));

-- 최적화 권고. 열린 권고는 (자원, 종류)당 1개만 유지한다.
CREATE TABLE resource_recommendations (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('rightsize_up','rightsize_down','sleep_tuning','orphan','idle','prune_backups','abort_multipart','engine_provider')),
  payload_json TEXT NOT NULL,
  est_saving_micro INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed','applied','expired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
CREATE UNIQUE INDEX uq_reco_open ON resource_recommendations(resource_id, kind) WHERE status = 'open';
