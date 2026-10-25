-- CloudPress 컨테이너·백업·스냅샷 스키마 (0007)
-- 0001~0006 적용 후 순차 적용

PRAGMA foreign_keys = ON;

-- 컨테이너 인스턴스 이미지(버전 관리)
CREATE TABLE container_images (
  id TEXT PRIMARY KEY,
  docker_image TEXT NOT NULL,
  instance_type TEXT NOT NULL CHECK (instance_type IN ('lite','basic','standard-1','standard-2','standard-3','standard-4','custom')),
  vcpu REAL NOT NULL,
  memory_mib INTEGER NOT NULL,
  disk_gb INTEGER NOT NULL,
  entrypoint TEXT NOT NULL DEFAULT '/entrypoint.sh',
  env_json TEXT NOT NULL DEFAULT '{}',
  labels_json TEXT NOT NULL DEFAULT '{}',
  scheduling_policy TEXT NOT NULL DEFAULT 'durable_object' CHECK (scheduling_policy IN ('default','durable_object')),
  supports_snapshot INTEGER NOT NULL DEFAULT 1 CHECK (supports_snapshot IN (0,1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deprecated_at TEXT
);
CREATE INDEX idx_images_type_policy ON container_images(instance_type, scheduling_policy, active);

-- 컨테이너 실행 인스턴스 상세(Worker <-> Container 통신용)
CREATE TABLE container_instances (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL REFERENCES container_images(id),
  cf_instance_id TEXT,
  scheduling_policy TEXT NOT NULL CHECK (scheduling_policy IN ('default','durable_object')),
  state TEXT NOT NULL DEFAULT 'starting' CHECK (state IN ('starting','running','sleeping','stopping','stopped','failed')),
  ip TEXT,
  port INTEGER,
  enable_internet INTEGER NOT NULL DEFAULT 0 CHECK (enable_internet IN (0,1)),
  intercept_targets_json TEXT NOT NULL DEFAULT '[]',
  labels_json TEXT NOT NULL DEFAULT '{}',
  last_heartbeat_at TEXT,
  started_at TEXT,
  stopped_at TEXT,
  exit_code INTEGER,
  exit_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (container_id, cf_instance_id)
);
CREATE INDEX idx_instances_container ON container_instances(container_id, state);

-- 백업 작업(청크 단위 AEAD 암호화 R2 업로드)
CREATE TABLE backup_jobs (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  database_id TEXT REFERENCES databases(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('full','incremental','binlog')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
  r2_prefix TEXT NOT NULL,
  chunks_total INTEGER NOT NULL DEFAULT 0,
  chunks_uploaded INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  sha256_manifest TEXT,
  encryption_key_id TEXT NOT NULL,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_backup_jobs_container ON backup_jobs(container_id, created_at);
CREATE INDEX idx_backup_jobs_db ON backup_jobs(database_id, created_at);

-- 백업 청크(개별 암호화 파일)
CREATE TABLE backup_chunks (
  id TEXT PRIMARY KEY,
  backup_job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 1 CHECK (encrypted = 1),
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (backup_job_id, chunk_index)
);
CREATE INDEX idx_chunks_job ON backup_chunks(backup_job_id);

-- 스냅샷(빠른 복구용, 30일 TTL, 이미지 변경 시 무효)
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL REFERENCES container_images(id),
  cf_snapshot_handle TEXT NOT NULL,
  size_bytes INTEGER,
  state TEXT NOT NULL DEFAULT 'creating' CHECK (state IN ('creating','ready','expired','invalid','restoring','deleted')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  restored_at TEXT,
  UNIQUE (container_id, cf_snapshot_handle)
);
CREATE INDEX idx_snapshots_container ON snapshots(container_id, state, expires_at);

-- 컨테이너 작업 큐 확장(프로비저닝/백업/스냅샷/복원)
CREATE TABLE container_jobs (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('provision','start','stop','restart','resize','backup_full','backup_incremental','backup_binlog','snapshot_create','snapshot_restore','snapshot_prune','delete')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','retrying','dead','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_cjobs_container_state ON container_jobs(container_id, state, scheduled_at);
CREATE INDEX idx_cjobs_kind_state ON container_jobs(kind, state);

-- 컨테이너 백업 설정(고객별)
CREATE TABLE container_backup_configs (
  container_id TEXT PRIMARY KEY REFERENCES containers(id) ON DELETE CASCADE,
  full_schedule_cron TEXT NOT NULL DEFAULT '0 3 * * *',
  incremental_schedule_cron TEXT NOT NULL DEFAULT '0 * * * *',
  binlog_schedule_cron TEXT NOT NULL DEFAULT '*/5 * * * *',
  retention_days INTEGER NOT NULL DEFAULT 30,
  encryption_key_version INTEGER NOT NULL DEFAULT 1,
  r2_bucket TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 컨테이너 스냅샷 설정
CREATE TABLE container_snapshot_configs (
  container_id TEXT PRIMARY KEY REFERENCES containers(id) ON DELETE CASCADE,
  schedule_cron TEXT NOT NULL DEFAULT '0 */6 * * *',
  max_snapshots INTEGER NOT NULL DEFAULT 10,
  ttl_days INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 컨테이너 암호화 키 회전 이력
CREATE TABLE container_encryption_keys (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL,
  key_material_b64 TEXT NOT NULL,
  derived_from_version INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retired_at TEXT,
  UNIQUE (container_id, key_version)
);
CREATE INDEX idx_enc_keys_container ON container_encryption_keys(container_id, key_version);

-- 복원 작업
CREATE TABLE restore_jobs (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('backup','snapshot')),
  source_id TEXT NOT NULL,
  target_image_id TEXT REFERENCES container_images(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
  progress_pct INTEGER NOT NULL DEFAULT 0,
  chunks_total INTEGER NOT NULL DEFAULT 0,
  chunks_restored INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_restore_jobs_container ON restore_jobs(container_id, created_at);

-- 컨테이너 배치 점수 계산용 호스트 메트릭(주기적 수집)
CREATE TABLE host_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  free_mem_mib INTEGER NOT NULL,
  free_vcpu REAL NOT NULL,
  cpu_load REAL NOT NULL,
  queue_depth INTEGER NOT NULL DEFAULT 0,
  error_rate REAL NOT NULL DEFAULT 0,
  restarts_7d INTEGER NOT NULL DEFAULT 0,
  est_cost_per_hour_micro INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  healthy INTEGER NOT NULL DEFAULT 1 CHECK (healthy IN (0,1)),
  supports_types_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_host_metrics_ts ON host_metrics(host_id, ts);

-- 기본 컨테이너 이미지 시드
INSERT INTO container_images (id, docker_image, instance_type, vcpu, memory_mib, disk_gb, entrypoint, scheduling_policy, supports_snapshot, is_default) VALUES
  ('img-ccs-lite', 'cloudpress/ccs-lite:latest', 'lite', 0.0625, 256, 2, '/entrypoint.sh', 'default', 0, 1),
  ('img-ccs-basic', 'cloudpress/ccs-basic:latest', 'basic', 0.25, 1024, 4, '/entrypoint.sh', 'default', 0, 1),
  ('img-ccs-standard1', 'cloudpress/ccs-standard:latest', 'standard-1', 0.5, 4096, 8, '/entrypoint.sh', 'durable_object', 1, 1),
  ('img-ccs-standard2', 'cloudpress/ccs-standard:latest', 'standard-2', 1, 6144, 12, '/entrypoint.sh', 'durable_object', 1, 1),
  ('img-ccs-standard3', 'cloudpress/ccs-standard:latest', 'standard-3', 2, 8192, 16, '/entrypoint.sh', 'durable_object', 1, 1),
  ('img-ccs-standard4', 'cloudpress/ccs-standard:latest', 'standard-4', 4, 12288, 20, '/entrypoint.sh', 'durable_object', 1, 1),
  ('img-cloudb-mariadb', 'cloudpress/cloudb-mariadb:latest', 'basic', 0.25, 1024, 4, '/entrypoint-mariadb.sh', 'durable_object', 1, 1),
  ('img-cloudb-mysql', 'cloudpress/cloudb-mysql:latest', 'basic', 0.25, 1024, 4, '/entrypoint-mysql.sh', 'durable_object', 1, 1),
  ('img-wp-starter', 'cloudpress/wp-starter:latest', 'basic', 0.25, 1024, 4, '/entrypoint-wp.sh', 'durable_object', 1, 1),
  ('img-wp-pro', 'cloudpress/wp-pro:latest', 'standard-1', 0.5, 4096, 8, '/entrypoint-wp.sh', 'durable_object', 1, 1),
  ('img-wp-business', 'cloudpress/wp-business:latest', 'standard-2', 1, 6144, 12, '/entrypoint-wp.sh', 'durable_object', 1, 1),
  ('img-wp-scale', 'cloudpress/wp-scale:latest', 'standard-3', 2, 8192, 16, '/entrypoint-wp.sh', 'durable_object', 1, 1);
