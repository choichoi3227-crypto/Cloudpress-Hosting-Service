-- 0005: 다중 등록기관(Cloudflare/가비아), 다중 통화(USD/KRW) 청구 기록, 환율·가격 이력.
-- 카탈로그 기준 통화는 USD 로 유지하고, KRW 금액은 견적 시점의 환율로 계산해 주문에 고정한다.
ALTER TABLE domain_orders ADD COLUMN registrar_provider TEXT NOT NULL DEFAULT 'cloudflare' CHECK (registrar_provider IN ('cloudflare','gabia'));
ALTER TABLE domain_orders ADD COLUMN charge_currency TEXT NOT NULL DEFAULT 'USD' CHECK (charge_currency IN ('USD','KRW'));
ALTER TABLE domain_orders ADD COLUMN charge_amount INTEGER;            -- KRW: 원, USD: 센트
ALTER TABLE domain_orders ADD COLUMN renewal_charge_amount INTEGER;
ALTER TABLE domain_orders ADD COLUMN fx_rate_micro INTEGER;            -- 견적 시점 환율: 원/USD × 1,000,000
ALTER TABLE domain_orders ADD COLUMN ns_delegated_at TEXT;             -- 등록기관 네임서버를 Cloudflare 로 위임한 시각

CREATE TABLE fx_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair TEXT NOT NULL CHECK (pair = 'USD/KRW'),
  rate_micro INTEGER NOT NULL CHECK (rate_micro > 0),
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','rejected','quarantined')),
  reason TEXT
);
CREATE INDEX idx_fx_rates_pair_time ON fx_rates(pair, fetched_at);

-- 가격 변경 이력(감사·히스테리시스 판단용). 범위 예: 'domain:com'
CREATE TABLE price_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD','KRW')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  cost_micro_usd INTEGER NOT NULL CHECK (cost_micro_usd > 0),
  fx_rate_micro INTEGER,
  reason TEXT,
  changed_at TEXT NOT NULL
);
CREATE INDEX idx_price_points_scope ON price_points(scope, currency, changed_at);
