-- 0004: 도메인 구매 주문, Cloudflare 영역(zone), DNS 레코드 미러, 영역 설정/규칙, 이미지 변환 예산.
-- 모든 변경은 서버(Worker)를 통해서만 수행한다. 고객에게 Cloudflare 토큰을 주지 않는다.

CREATE TABLE domain_orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  hostname TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','paid','registering','registered','failed','needs_review','refund_due','refunded','quote_expired')),
  registrar_cost_micro INTEGER NOT NULL CHECK (registrar_cost_micro > 0),
  renewal_cost_micro INTEGER NOT NULL CHECK (renewal_cost_micro > 0),
  price_micro INTEGER NOT NULL CHECK (price_micro > 0),
  renewal_price_micro INTEGER NOT NULL CHECK (renewal_price_micro > 0),
  quote_expires_at TEXT NOT NULL,
  stripe_payment_intent_id TEXT UNIQUE,
  registrant_enc TEXT,                       -- 등록자 연락처(개인정보): AES-GCM 암호문만 저장
  registrar_state TEXT,
  registered_at TEXT,
  expires_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- 같은 도메인을 두 번 구매하지 못하도록: 도메인을 점유한(결제 후 등록 전·등록 중·완료·검토) 주문은 도메인당 1개만 허용. refund_due 는 점유하지 않으므로 제외.
CREATE UNIQUE INDEX uq_domain_orders_committed ON domain_orders(hostname) WHERE status IN ('paid','registering','registered','needs_review');
CREATE INDEX idx_domain_orders_customer ON domain_orders(customer_id, status);

CREATE TABLE dns_zones (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  hostname TEXT NOT NULL UNIQUE COLLATE NOCASE,
  cf_zone_id TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('registered','connected')),
  status TEXT NOT NULL DEFAULT 'pending_nameservers' CHECK (status IN ('pending_nameservers','active','moved','suspended','deleted')),
  name_servers_json TEXT NOT NULL DEFAULT '[]',
  order_id TEXT REFERENCES domain_orders(id),
  activation_checks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  activated_at TEXT,
  last_checked_at TEXT
);
CREATE INDEX idx_dns_zones_customer ON dns_zones(customer_id, status);

CREATE TABLE dns_records (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES dns_zones(id) ON DELETE CASCADE,
  cf_record_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('A','AAAA','CNAME','MX','TXT','SRV','CAA','NS')),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  ttl INTEGER NOT NULL CHECK (ttl = 1 OR (ttl >= 60 AND ttl <= 86400)),
  proxied INTEGER NOT NULL DEFAULT 0 CHECK (proxied IN (0,1)),
  priority INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (proxied = 0 OR type IN ('A','AAAA','CNAME'))
);
CREATE INDEX idx_dns_records_zone ON dns_records(zone_id, type, name);

CREATE TABLE zone_settings (
  zone_id TEXT NOT NULL REFERENCES dns_zones(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (zone_id, setting_key)
);

CREATE TABLE zone_rules (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES dns_zones(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  rule_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (zone_id, phase, position)
);

-- Cloudflare Images 변환: 계정 공용 무료 5,000건/월을 버킷별로 공정 배분하기 위한 사용량.
CREATE TABLE image_transform_usage (
  bucket_id TEXT NOT NULL REFERENCES storage_buckets(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                      -- UTC YYYY-MM
  unique_count INTEGER NOT NULL DEFAULT 0 CHECK (unique_count >= 0),
  PRIMARY KEY (bucket_id, month)
);
