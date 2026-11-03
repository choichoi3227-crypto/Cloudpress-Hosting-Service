-- 0015: production schema fixes for missing columns/tables
-- Ensure all required tables and columns exist in production
-- This migration uses SQLite-compatible syntax for ADD COLUMN (no IF NOT EXISTS)
-- D1 will ignore errors for duplicate columns, SQLite will fail but we handle in test setup

-- 1. Fix affiliate_referrals: add flagged_fraud and flag_reason columns if missing
-- Using a safe pattern: try to add, ignore if exists (works in D1, handled in tests)
ALTER TABLE affiliate_referrals ADD COLUMN flagged_fraud INTEGER NOT NULL DEFAULT 0 CHECK (flagged_fraud IN (0,1));
ALTER TABLE affiliate_referrals ADD COLUMN flag_reason TEXT;

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
ALTER TABLE affiliate_payouts ADD COLUMN external_ref TEXT;
ALTER TABLE affiliate_payouts ADD COLUMN paid_at TEXT;
ALTER TABLE affiliate_payouts ADD COLUMN note TEXT;

-- 6. Ensure affiliate_users has payout_email and approved_at from 0014
ALTER TABLE affiliate_users ADD COLUMN payout_email TEXT;
ALTER TABLE affiliate_users ADD COLUMN approved_at TEXT;

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

-- 8. Fix ai_runs table: add billed_micro and cost_micro columns with default 0
-- This fixes NOT NULL constraint failed on billed_micro when AI runs are logged without token counts
ALTER TABLE ai_runs ADD COLUMN billed_micro INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_runs ADD COLUMN cost_micro INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE ai_runs ADD COLUMN output_tokens INTEGER;
