-- 0006: 결제 통화(USD/KRW) 정확 기록, 통화별 Stripe 가격 매핑(가격 버전 고정), 작업 재시도 일정.
ALTER TABLE payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','KRW'));
ALTER TABLE payments ADD COLUMN amount_minor INTEGER;          -- 결제 통화 최소 단위(USD: 센트, KRW: 원)
ALTER TABLE payments ADD COLUMN fx_rate_micro INTEGER;         -- KRW 결제의 USD 환산에 쓴 환율(원/USD × 1e6)
ALTER TABLE invoices ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','KRW'));
ALTER TABLE invoices ADD COLUMN total_minor INTEGER;
ALTER TABLE deployment_jobs ADD COLUMN next_run_at TEXT;

-- 가격 버전 × 통화 → 금액·Stripe Price. 한 번 만들어지면 불변(가격 변경은 새 가격 버전으로).
CREATE TABLE price_amounts (
  price_id TEXT NOT NULL REFERENCES prices(id),
  currency TEXT NOT NULL CHECK (currency IN ('USD','KRW')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  fx_rate_micro INTEGER,
  stripe_price_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (price_id, currency)
);
