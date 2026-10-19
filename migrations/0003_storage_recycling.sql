-- 0003: Cloudage 용량 약정(entitlement)·최적화 정책·일별 사용량·용량 대여(재활용) 원장.
-- 개별 객체의 최적화 상태는 D1 이 아니라 R2 customMetadata 에 저장한다(D1 쓰기 비용·행 수 절감).
ALTER TABLE storage_buckets ADD COLUMN entitlement_bytes INTEGER NOT NULL DEFAULT 10000000000 CHECK (entitlement_bytes > 0);
ALTER TABLE storage_buckets ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE storage_usage_daily (
  bucket_id TEXT NOT NULL REFERENCES storage_buckets(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                       -- UTC YYYY-MM-DD
  logical_peak_bytes INTEGER NOT NULL CHECK (logical_peak_bytes >= 0),
  logical_end_bytes INTEGER NOT NULL CHECK (logical_end_bytes >= 0),
  physical_end_bytes INTEGER NOT NULL CHECK (physical_end_bytes >= 0),
  objects INTEGER NOT NULL DEFAULT 0,
  saved_bytes INTEGER NOT NULL DEFAULT 0,  -- 압축·중복제거로 절감한 물리 바이트
  PRIMARY KEY (bucket_id, day)
);

-- 용량 대여: 남는 논리 약정을 다른 서비스에 빌려준다. 대여자의 약정은 언제든 회수(recall)로 복구된다.
CREATE TABLE storage_loans (
  id TEXT PRIMARY KEY,
  lender_bucket_id TEXT NOT NULL REFERENCES storage_buckets(id),
  borrower_bucket_id TEXT NOT NULL REFERENCES storage_buckets(id),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  scope TEXT NOT NULL CHECK (scope IN ('customer','platform')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','recalling','returned')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  recall_requested_at TEXT,
  recall_effective_at TEXT,
  returned_at TEXT,
  CHECK (lender_bucket_id <> borrower_bucket_id)
);
CREATE INDEX idx_loans_lender ON storage_loans(lender_bucket_id, status);
CREATE INDEX idx_loans_borrower ON storage_loans(borrower_bucket_id, status);

CREATE TABLE storage_optimization_runs (
  id TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL REFERENCES storage_buckets(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  objects_scanned INTEGER NOT NULL DEFAULT 0,
  objects_optimized INTEGER NOT NULL DEFAULT 0,
  bytes_before INTEGER NOT NULL DEFAULT 0,
  bytes_after INTEGER NOT NULL DEFAULT 0,
  class_a_ops INTEGER NOT NULL DEFAULT 0
);
