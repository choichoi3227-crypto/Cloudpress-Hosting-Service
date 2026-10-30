-- 0012: CAS(CloudPress AI Service). PayPal 은 임의 금액 사용량 후불 청구가 불가능(구독 capture 는 결제 실패 미수금만 가능)하므로
-- 사용량 요금은 선불 크레딧(원장)에서 차감한다. 크레딧이 모자라면 요청을 막아 미수금이 생기지 않는다.

ALTER TABLE ai_models ADD COLUMN input_neurons_per_m INTEGER;   -- 입력 100만 토큰당 Neurons(공식 가격표 환산). NULL 이면 판매 불가
ALTER TABLE ai_models ADD COLUMN output_neurons_per_m INTEGER;
ALTER TABLE ai_models ADD COLUMN unit_neurons INTEGER;          -- 토큰이 아닌 단위(이미지 1장, 오디오 1초 등)당 Neurons
ALTER TABLE ai_models ADD COLUMN pricing_source TEXT NOT NULL DEFAULT 'none';  -- none | cloudflare_api | admin

CREATE TABLE IF NOT EXISTS ai_api_keys (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,                 -- SHA-256. 원문은 저장하지 않는다(발급 시 1회만 표시)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','blocked')),
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit_per_min > 0),
  monthly_cap_micro INTEGER,                      -- 키별 월 비용 상한(NULL=크레딧 잔액만 제한)
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_keys_customer ON ai_api_keys(customer_id);

CREATE TABLE IF NOT EXISTS cas_model_access (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  model_id TEXT NOT NULL REFERENCES ai_models(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cas_access_customer ON cas_model_access(customer_id, model_id);

CREATE TABLE IF NOT EXISTS ai_credit_ledger (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('topup','usage','adjust','refund')),
  amount_micro INTEGER NOT NULL,                  -- 충전은 +, 사용은 -
  ref TEXT NOT NULL UNIQUE,                       -- 멱등 키(캡처 ID / 요청 ID)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_ledger_customer ON ai_credit_ledger(customer_id, created_at);

CREATE TABLE IF NOT EXISTS ai_credit_topups (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  amount_micro INTEGER NOT NULL CHECK (amount_micro > 0),
  paypal_order_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_key_ts ON ai_usage_records(api_key_id, ts);
