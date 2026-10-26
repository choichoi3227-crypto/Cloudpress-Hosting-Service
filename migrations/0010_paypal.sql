-- 0010: 결제 사업자를 Stripe 에서 PayPal 로 전환.
-- 기존 stripe_* 컬럼은 과거 데이터 보존을 위해 남기고(삭제하지 않음), PayPal 식별자 컬럼을 추가한다.
-- 참고: domain_orders.stripe_payment_intent_id 는 이름이 남아 있지만 이제 "외부 결제 참조(PayPal capture id)"로 쓴다.
--       payments.rail 의 CHECK 제약(stripe|x402)은 ALTER 로 바꿀 수 없어 그대로 두고, 결제 사업자는 provider 컬럼으로 구분한다.

ALTER TABLE subscriptions ADD COLUMN paypal_plan_id TEXT;
ALTER TABLE subscriptions ADD COLUMN paypal_subscription_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_paypal ON subscriptions(paypal_subscription_id) WHERE paypal_subscription_id IS NOT NULL;

ALTER TABLE price_amounts ADD COLUMN paypal_plan_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_amounts_paypal ON price_amounts(paypal_plan_id) WHERE paypal_plan_id IS NOT NULL;

ALTER TABLE invoices ADD COLUMN paypal_sale_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_paypal ON invoices(paypal_sale_id) WHERE paypal_sale_id IS NOT NULL;

ALTER TABLE payments ADD COLUMN provider TEXT NOT NULL DEFAULT 'stripe';
ALTER TABLE payments ADD COLUMN paypal_capture_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pay_paypal ON payments(paypal_capture_id) WHERE paypal_capture_id IS NOT NULL;

ALTER TABLE refunds ADD COLUMN paypal_refund_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ref_paypal ON refunds(paypal_refund_id) WHERE paypal_refund_id IS NOT NULL;

ALTER TABLE domain_orders ADD COLUMN paypal_order_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dom_paypal_order ON domain_orders(paypal_order_id) WHERE paypal_order_id IS NOT NULL;

ALTER TABLE webhook_events ADD COLUMN provider TEXT NOT NULL DEFAULT 'stripe';
