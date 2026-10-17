-- CloudPress D1 초기 스키마. 시간은 UTC ISO-8601 TEXT, 금액은 micro-USD 정수.
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin','affiliate_only')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  stripe_customer_id TEXT UNIQUE,
  locale TEXT NOT NULL DEFAULT 'ko',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user ON user_sessions(user_id);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ccs','cloudb','cloudage','csw','wordpress','cas','supabase_pg','cpu_upgrade')),
  name_ko TEXT NOT NULL,
  instance_type TEXT,
  target_vcpu REAL,
  included_active_hours INTEGER,
  included_storage_gb INTEGER,
  on_sale INTEGER NOT NULL DEFAULT 1 CHECK (on_sale IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE product_versions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  spec_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (product_id, version)
);

-- 가격은 불변. 변경 = 새 가격 버전 행 추가. 기존 구독은 price_version_id 를 유지한다.
CREATE TABLE prices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  monthly_micro INTEGER NOT NULL CHECK (monthly_micro > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  rates_json TEXT NOT NULL DEFAULT '{}',
  stripe_price_id TEXT UNIQUE,
  active_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retired_at TEXT,
  UNIQUE (product_id, version)
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  price_version_id TEXT NOT NULL REFERENCES prices(id),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id TEXT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  billing_interval TEXT NOT NULL DEFAULT 'month' CHECK (billing_interval = 'month'),
  status TEXT NOT NULL DEFAULT 'incomplete' CHECK (status IN ('incomplete','active','past_due','suspended','canceling','canceled','refunded')),
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  usage_limit_micro INTEGER,
  usage_amount_micro INTEGER NOT NULL DEFAULT 0 CHECK (usage_amount_micro >= 0),
  last_invoice_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sub_customer ON subscriptions(customer_id, status);

CREATE TABLE subscription_items (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('base','cpu_upgrade','multisite','storage','included_component')),
  price_version_id TEXT REFERENCES prices(id),
  stripe_subscription_item_id TEXT UNIQUE,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  billable INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','removed')),
  effective_from TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_items_sub ON subscription_items(subscription_id);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  subscription_id TEXT REFERENCES subscriptions(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  stripe_invoice_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft','open','paid','uncollectible','void')),
  subtotal_micro INTEGER NOT NULL,
  credit_micro INTEGER NOT NULL DEFAULT 0,
  total_micro INTEGER NOT NULL,
  lines_json TEXT NOT NULL DEFAULT '[]',
  period_start TEXT,
  period_end TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_inv_customer ON invoices(customer_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT REFERENCES invoices(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_charge_id TEXT UNIQUE,
  amount_micro INTEGER NOT NULL CHECK (amount_micro >= 0),
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','refunded','partially_refunded','disputed')),
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  stripe_refund_id TEXT UNIQUE,
  amount_micro INTEGER NOT NULL CHECK (amount_micro > 0),
  reason TEXT,
  kind TEXT NOT NULL DEFAULT 'refund' CHECK (kind IN ('refund','chargeback')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE containers (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  instance_type TEXT NOT NULL CHECK (instance_type IN ('lite','basic','standard-1','standard-2','standard-3','standard-4')),
  target_vcpu REAL NOT NULL,
  actual_vcpu REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'provisioning' CHECK (state IN ('provisioning','running','sleeping','stopped','failed','deleting','deleted')),
  sleep_policy TEXT NOT NULL DEFAULT 'idle' CHECK (sleep_policy IN ('idle','never')),
  durable_object_id TEXT,
  last_snapshot_id TEXT,
  last_backup_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  CHECK (target_vcpu >= actual_vcpu OR target_vcpu = actual_vcpu)
);
CREATE INDEX idx_containers_customer ON containers(customer_id, state);

CREATE TABLE container_assignments (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  placement_json TEXT NOT NULL,
  score REAL,
  reason TEXT,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_at TEXT
);

CREATE TABLE container_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('platform','app')),
  cpu_active_ms INTEGER,
  mem_used_mib INTEGER,
  disk_used_mb INTEGER,
  requests INTEGER,
  p95_latency_ms INTEGER,
  error_rate_bp INTEGER,
  egress_bytes INTEGER
);
CREATE INDEX idx_metrics_container_ts ON container_metrics(container_id, ts);

CREATE TABLE cpu_addons (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  container_id TEXT NOT NULL REFERENCES containers(id),
  from_instance_type TEXT NOT NULL,
  to_instance_type TEXT NOT NULL,
  purchase_status TEXT NOT NULL DEFAULT 'pending' CHECK (purchase_status IN ('pending','paid','cancelled','refunded')),
  apply_status TEXT NOT NULL DEFAULT 'not_started' CHECK (apply_status IN ('not_started','queued','applying','applied','failed','rolled_back')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied_at TEXT
);

CREATE TABLE databases (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  engine TEXT NOT NULL CHECK (engine IN ('mariadb','postgres')),
  provider TEXT NOT NULL CHECK (provider IN ('cloudb_container','supabase')),
  container_id TEXT REFERENCES containers(id),
  external_project_ref TEXT,
  ha_tier INTEGER NOT NULL DEFAULT 0 CHECK (ha_tier IN (0,1)),
  state TEXT NOT NULL DEFAULT 'provisioning' CHECK (state IN ('provisioning','ready','degraded','failed','deleting','deleted')),
  secret_ref TEXT,
  storage_limit_gb INTEGER NOT NULL DEFAULT 2,
  last_backup_at TEXT,
  last_restore_test_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (subscription_id)
);

CREATE TABLE storage_buckets (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  r2_bucket_name TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  cors_json TEXT,
  lifecycle_json TEXT,
  state TEXT NOT NULL DEFAULT 'provisioning' CHECK (state IN ('provisioning','ready','failed','deleting','deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (subscription_id)
);

CREATE TABLE worker_services (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  logical_name TEXT NOT NULL,
  route_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','disabled','deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (customer_id, logical_name)
);

CREATE TABLE ai_models (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  io_format TEXT,
  tier TEXT NOT NULL CHECK (tier IN ('general','performance','premium')),
  official_status TEXT NOT NULL DEFAULT 'unknown',
  billing_unit TEXT NOT NULL DEFAULT 'neurons',
  uses_neurons INTEGER NOT NULL DEFAULT 1 CHECK (uses_neurons IN (0,1)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  last_synced_at TEXT
);

CREATE TABLE ai_model_prices (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES ai_models(id),
  version INTEGER NOT NULL,
  monthly_micro INTEGER NOT NULL CHECK (monthly_micro >= 0),
  sell_per_1k_micro INTEGER NOT NULL CHECK (sell_per_1k_micro >= 0),
  cost_per_1k_micro INTEGER NOT NULL DEFAULT 0,
  active_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (model_id, version)
);

CREATE TABLE ai_usage_records (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  api_key_id TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES ai_models(id),
  request_id TEXT NOT NULL UNIQUE,
  neurons INTEGER NOT NULL CHECK (neurons >= 0),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  billed_micro INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ai_usage_sub_ts ON ai_usage_records(subscription_id, ts);

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metric TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL
);
CREATE INDEX idx_usage_sub_ts ON usage_records(subscription_id, ts);

CREATE TABLE usage_aggregates (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  period TEXT NOT NULL,
  metric TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL,
  billed_micro INTEGER NOT NULL DEFAULT 0,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  UNIQUE (subscription_id, period, metric)
);

CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  hostname TEXT NOT NULL UNIQUE COLLATE NOCASE,
  verification_token TEXT NOT NULL,
  ownership_status TEXT NOT NULL DEFAULT 'pending' CHECK (ownership_status IN ('pending','verified','failed')),
  ssl_status TEXT NOT NULL DEFAULT 'none' CHECK (ssl_status IN ('none','pending','active','renewing','failed')),
  custom_hostname_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE deployment_jobs (
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_jobs_state ON deployment_jobs(state, created_at);

CREATE TABLE queue_jobs (
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  deployment_job_id TEXT REFERENCES deployment_jobs(id),
  message_id TEXT,
  state TEXT NOT NULL DEFAULT 'enqueued' CHECK (state IN ('enqueued','delivered','acked','retry','dlq')),
  enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE affiliate_users (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended','rejected')),
  payout_method TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE affiliate_referrals (
  id TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliate_users(id),
  referred_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  first_qualifying_payment_at TEXT,
  flagged_fraud INTEGER NOT NULL DEFAULT 0 CHECK (flagged_fraud IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (affiliate_id <> referred_user_id)
);

CREATE TABLE affiliate_commissions (
  id TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliate_users(id),
  referral_id TEXT NOT NULL REFERENCES affiliate_referrals(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  amount_micro INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','eligible','payable','paid','void','clawed_back')),
  payout_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (payment_id, affiliate_id)
);

CREATE TABLE affiliate_payouts (
  id TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliate_users(id),
  period TEXT NOT NULL,
  amount_micro INTEGER NOT NULL CHECK (amount_micro >= 0),
  carryover_micro INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','failed','rejected')),
  approved_by TEXT REFERENCES users(id),
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (affiliate_id, period)
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,           -- Stripe event id (중복 방지)
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','ignored')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail_json TEXT,
  ip_hash TEXT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id);

CREATE TABLE admin_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  audience TEXT NOT NULL DEFAULT 'customer' CHECK (audience IN ('customer','operator')),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title TEXT NOT NULL,
  body TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 백업 이력(R2). 복원 검증 결과를 함께 기록한다.
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id),
  kind TEXT NOT NULL CHECK (kind IN ('full','incremental','binlog','snapshot','logical')),
  r2_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER,
  sha256 TEXT,
  encrypted INTEGER NOT NULL DEFAULT 1 CHECK (encrypted = 1),
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_backups_db ON backups(database_id, created_at);

-- SLA 측정: 합성 프로브와 장애 구간.
CREATE TABLE sla_probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  vantage TEXT NOT NULL,
  ts TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0,1)),
  latency_ms INTEGER
);
CREATE INDEX idx_probes_res_ts ON sla_probes(resource_id, ts);

CREATE TABLE sla_incidents (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0,1)),
  cause TEXT
);
