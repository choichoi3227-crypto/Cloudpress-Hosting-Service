-- 0011: 추가 CPU 구매(PayPal 별도 구독). cpu_addons 는 "구매 상태(purchase_status)"와 "적용 상태(apply_status)"를 분리한다.
ALTER TABLE cpu_addons ADD COLUMN add_vcpu INTEGER;
ALTER TABLE cpu_addons ADD COLUMN monthly_micro INTEGER;
ALTER TABLE cpu_addons ADD COLUMN paypal_plan_id TEXT;
ALTER TABLE cpu_addons ADD COLUMN paypal_subscription_id TEXT;
ALTER TABLE cpu_addons ADD COLUMN current_period_end TEXT;
ALTER TABLE cpu_addons ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cpu_addons ADD COLUMN last_error TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cpu_addons_paypal ON cpu_addons(paypal_subscription_id) WHERE paypal_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cpu_addons_sub ON cpu_addons(subscription_id, purchase_status);

-- PayPal 플랜 캐시: (추가 vCPU, 월 가격) 조합마다 1개. 가격이 바뀌면 새 플랜이 생겨 기존 구매자는 기존 가격을 유지한다.
CREATE TABLE IF NOT EXISTS cpu_addon_plans (
  add_vcpu INTEGER NOT NULL,
  monthly_micro INTEGER NOT NULL,
  paypal_plan_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (add_vcpu, monthly_micro)
);
