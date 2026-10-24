-- Service Mesh: Service endpoints, traffic policies, mTLS certificates
PRAGMA foreign_keys = ON;

CREATE TABLE service_endpoints (
  id TEXT PRIMARY KEY,
  service_name TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  container_id TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  port INTEGER NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('http','https','tcp','grpc')),
  health_check_path TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  healthy INTEGER NOT NULL DEFAULT 1 CHECK (healthy IN (0,1)),
  deregistered_at TEXT
);
CREATE INDEX idx_service_endpoints_lookup ON service_endpoints(service_name, namespace, healthy);
CREATE INDEX idx_service_endpoints_container ON service_endpoints(container_id);

CREATE TABLE traffic_policies (
  id TEXT PRIMARY KEY,
  source_service TEXT NOT NULL,
  target_service TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  policy TEXT NOT NULL CHECK (policy IN ('allow','deny','rate_limit','retry','timeout','circuit_breaker')),
  config_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_traffic_policies_lookup ON traffic_policies(source_service, target_service, namespace);

CREATE TABLE service_certificates (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  service_name TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  sans_json TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  revoked_at TEXT
);
CREATE INDEX idx_service_certificates_lookup ON service_certificates(service_name, namespace, revoked);

-- Database Manager: Read replicas, connection pooling, PITR
CREATE TABLE database_replicas (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  replica_type TEXT NOT NULL CHECK (replica_type IN ('sync','async','cascade')),
  endpoint_host TEXT NOT NULL,
  endpoint_port INTEGER NOT NULL DEFAULT 3306,
  status TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','healthy','lagging','unhealthy','deleting','deleted')),
  replication_lag_ms INTEGER,
  last_check_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-dT%H:%M:%fZ','now'))
);

CREATE TABLE database_connection_pools (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  pool_name TEXT NOT NULL,
  min_connections INTEGER NOT NULL DEFAULT 2,
  max_connections INTEGER NOT NULL DEFAULT 20,
  idle_timeout_sec INTEGER NOT NULL DEFAULT 300,
  max_lifetime_sec INTEGER NOT NULL DEFAULT 3600,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-dT%H:%M:%fZ','now')),
  UNIQUE (database_id, pool_name)
);

CREATE TABLE database_pitr_snapshots (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  wal_start_lsn TEXT,
  wal_end_lsn TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_pitr_database_time ON database_pitr_snapshots(database_id, created_at);

-- API Gateway: Rate limiting, request/response transforms
CREATE TABLE api_gateway_routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path_pattern TEXT NOT NULL,
  methods_json TEXT NOT NULL DEFAULT '["GET","POST","PUT","PATCH","DELETE"]',
  target_service TEXT,
  target_url TEXT,
  strip_path_prefix INTEGER NOT NULL DEFAULT 0 CHECK (strip_path_prefix IN (0,1)),
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  retries INTEGER NOT NULL DEFAULT 3,
  retry_backoff_ms INTEGER NOT NULL DEFAULT 100,
  circuit_breaker_threshold INTEGER NOT NULL DEFAULT 5,
  circuit_breaker_timeout_sec INTEGER NOT NULL DEFAULT 30,
  auth_required INTEGER NOT NULL DEFAULT 1 CHECK (auth_required IN (0,1)),
  roles_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-dT%H:%M:%fZ','now'))
);

CREATE TABLE api_gateway_transforms (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES api_gateway_routes(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('request','response')),
  transform_type TEXT NOT NULL CHECK (transform_type IN ('add_header','remove_header','rewrite_path','rewrite_body','add_query','remove_query')),
  match_condition_json TEXT,
  config_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-dT%H:%M:%fZ','now'))
);

CREATE TABLE api_gateway_rate_limits (
  id TEXT PRIMARY KEY,
  route_id TEXT REFERENCES api_gateway_routes(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('global','route','ip','user','api_key')),
  limit_requests INTEGER NOT NULL,
  window_sec INTEGER NOT NULL,
  key_prefix TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-dT%H:%M:%fZ','now')),
  UNIQUE (route_id, scope, key_prefix)
);

-- Observability: Metrics, logs, traces, alerting
CREATE TABLE observability_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  value REAL NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_obs_metrics_name_time ON observability_metrics(metric_name, timestamp);

CREATE TABLE observability_alerts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  metric_name TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  notification_channels_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-dT%H:%M:%fZ','now'))
);

CREATE TABLE observability_alert_events (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES observability_alerts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('firing','resolved','acknowledged')),
  value REAL,
  labels_json TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT
);
CREATE INDEX idx_alert_events_status ON observability_alert_events(status, started_at);
