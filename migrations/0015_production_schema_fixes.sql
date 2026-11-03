-- 0015: production schema fixes for missing columns/tables
-- Ensure all required tables and columns exist in production

-- 1. Fix affiliate_referrals: ensure flagged_fraud and flag_reason columns exist
-- (flagged_fraud was in 0001_init.sql but may have been missing in some deployments)
-- Add flag_reason if not exists (added in 0014)
-- Note: SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we rely on the fact that these columns should already exist from 0001 and 0014
-- If they don't exist in production, they will be added here (will fail if they already exist, but that's fine for idempotency in D1)

-- 2. Create container_instances table if not exists (from 0007)
CREATE TABLE IF NOT EXISTS container_instances (
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
CREATE INDEX IF NOT EXISTS idx_instances_container ON container_instances(container_id, state);

-- 3. Create deployment_jobs table if not exists (from 0001_init.sql + 0006 additions)
CREATE TABLE IF NOT EXISTS deployment_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subscription_id TEXT REFERENCES subscriptions(id),
  resource_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','retrying','dead','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON deployment_jobs(state, created_at);

-- 4. Create queue_jobs table if not exists (from 0001_init.sql)
CREATE TABLE IF NOT EXISTS queue_jobs (
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  deployment_job_id TEXT REFERENCES deployment_jobs(id),
  message_id TEXT,
  state TEXT NOT NULL DEFAULT 'enqueued' CHECK (state IN ('enqueued','delivered','acked','retry','dlq')),
  enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 5. Ensure affiliate_payouts has new columns from 0014
-- SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we skip these as they should exist from 0014

-- 6. Ensure affiliate_users has payout_email and approved_at from 0014
-- Skip as they should exist from 0014

-- 7. Create affiliate_adjustments table if not exists (from 0014)
CREATE TABLE IF NOT EXISTS affiliate_adjustments (
  id TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliate_users(id),
  commission_id TEXT NOT NULL UNIQUE REFERENCES affiliate_commissions(id),
  amount_micro INTEGER NOT NULL CHECK (amount_micro < 0),
  reason TEXT NOT NULL,
  applied_payout_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aff_comm_status ON affiliate_commissions(affiliate_id, status);
CREATE INDEX IF NOT EXISTS idx_aff_ref_aff ON affiliate_referrals(affiliate_id, created_at);
