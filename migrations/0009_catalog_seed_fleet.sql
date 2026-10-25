-- 0009: 코드가 참조하지만 이전 마이그레이션에 없던 테이블 + 판매 상품 시드.
-- 시드는 INSERT OR IGNORE 이므로 재실행해도 기존 가격(가격 버전)을 덮어쓰지 않는다. 가격 변경은 새 prices 버전 행으로만 한다.

CREATE TABLE IF NOT EXISTS fleet_deployments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subscription_id TEXT,
  strategy_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 1,
  target_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_fleet_dep_sub ON fleet_deployments(subscription_id);

CREATE TABLE IF NOT EXISTS fleet_rollbacks (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES fleet_deployments(id),
  reason TEXT,
  initiated_by TEXT NOT NULL DEFAULT 'system',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS observability_slos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  service TEXT NOT NULL,
  sli_json TEXT NOT NULL,
  target REAL NOT NULL,
  window TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 비밀값은 반드시 암호문(AES-GCM, v1.<iv>.<ct>)만 저장한다. 평문 저장 금지.
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('ccs-lite','ccs','CCS Lite','lite',0.0625,NULL,NULL,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_ccs-lite_1','ccs-lite',1,'{"includes":[],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_ccs-lite_1','ccs-lite',1,4990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('ccs-basic','ccs','CCS Basic','basic',0.25,NULL,NULL,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_ccs-basic_1','ccs-basic',1,'{"includes":[],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_ccs-basic_1','ccs-basic',1,12990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('ccs-standard','ccs','CCS Standard','standard-1',0.5,360,NULL,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_ccs-standard_1','ccs-standard',1,'{"includes":[],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_ccs-standard_1','ccs-standard',1,34990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('ccs-performance','ccs','CCS Performance','standard-3',2,360,NULL,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_ccs-performance_1','ccs-performance',1,'{"includes":[],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_ccs-performance_1','ccs-performance',1,59990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('cloudb-mariadb','cloudb','ClouDB MariaDB','basic',0.25,NULL,2,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_cloudb-mariadb_1','cloudb-mariadb',1,'{"includes":[],"engine":"mariadb","pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_cloudb-mariadb_1','cloudb-mariadb',1,12990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('cloudb-mysql','cloudb','ClouDB MySQL','basic',0.25,NULL,2,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_cloudb-mysql_1','cloudb-mysql',1,'{"includes":[],"engine":"mysql","pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_cloudb-mysql_1','cloudb-mysql',1,12990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('cloudb-sqlite','cloudb_sqlite','ClouDB SQLite',NULL,NULL,NULL,2,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_cloudb-sqlite_1','cloudb-sqlite',1,'{"includes":[],"engine":"sqlite","pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_cloudb-sqlite_1','cloudb-sqlite',1,4990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('cloudage-bucket','cloudage','Cloudage 버킷',NULL,NULL,NULL,10,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_cloudage-bucket_1','cloudage-bucket',1,'{"includes":[],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_cloudage-bucket_1','cloudage-bucket',1,7990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('csw-service','csw','CSW 서비스',NULL,NULL,NULL,NULL,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_csw-service_1','csw-service',1,'{"includes":[],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_csw-service_1','csw-service',1,4990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('wp-starter','wordpress','WordPress Starter','basic',0.25,NULL,5,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_wp-starter_1','wp-starter',1,'{"includes":["ccs","cloudb","cloudage","csw"],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_wp-starter_1','wp-starter',1,19990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('wp-pro','wordpress','WordPress Pro','standard-1',0.5,NULL,20,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_wp-pro_1','wp-pro',1,'{"includes":["ccs","cloudb","cloudage","csw"],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_wp-pro_1','wp-pro',1,34990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('wp-business','wordpress','WordPress Business','standard-2',1,NULL,50,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_wp-business_1','wp-business',1,'{"includes":["ccs","cloudb","cloudage","csw"],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_wp-business_1','wp-business',1,59990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('wp-scale','wordpress','WordPress Scale','standard-3',2,NULL,100,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_wp-scale_1','wp-scale',1,'{"includes":["ccs","cloudb","cloudage","csw"],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_wp-scale_1','wp-scale',1,99990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('cas-general','cas','CAS 일반 모델',NULL,NULL,NULL,NULL,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_cas-general_1','cas-general',1,'{"includes":[],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_cas-general_1','cas-general',1,990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('cas-performance','cas','CAS 고성능 모델',NULL,NULL,NULL,NULL,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_cas-performance_1','cas-performance',1,'{"includes":[],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_cas-performance_1','cas-performance',1,2990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('cas-premium','cas','CAS 프리미엄 모델',NULL,NULL,NULL,NULL,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_cas-premium_1','cas-premium',1,'{"includes":[],"engine":null,"pgSizeClass":null}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_cas-premium_1','cas-premium',1,4990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('pg-micro','cloudb_pg','ClouDB PostgreSQL Micro',NULL,NULL,NULL,8,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_pg-micro_1','pg-micro',1,'{"includes":[],"engine":"postgres","pgSizeClass":"micro"}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_pg-micro_1','pg-micro',1,19990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('pg-small','cloudb_pg','ClouDB PostgreSQL Small',NULL,NULL,NULL,8,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_pg-small_1','pg-small',1,'{"includes":[],"engine":"postgres","pgSizeClass":"small"}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_pg-small_1','pg-small',1,26990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('pg-medium','cloudb_pg','ClouDB PostgreSQL Medium',NULL,NULL,NULL,8,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_pg-medium_1','pg-medium',1,'{"includes":[],"engine":"postgres","pgSizeClass":"medium"}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_pg-medium_1','pg-medium',1,99990000,'USD');
INSERT OR IGNORE INTO products(id,kind,name_ko,instance_type,target_vcpu,included_active_hours,included_storage_gb,on_sale) VALUES('pg-large','cloudb_pg','ClouDB PostgreSQL Large',NULL,NULL,NULL,8,1);
INSERT OR IGNORE INTO product_versions(id,product_id,version,spec_json) VALUES('pv_pg-large_1','pg-large',1,'{"includes":[],"engine":"postgres","pgSizeClass":"large"}');
INSERT OR IGNORE INTO prices(id,product_id,version,monthly_micro,currency) VALUES('price_pg-large_1','pg-large',1,179990000,'USD');

