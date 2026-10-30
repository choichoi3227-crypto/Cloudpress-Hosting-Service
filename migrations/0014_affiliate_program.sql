-- 0014: 제휴(Affiliate) 운영. 추천 추적·수수료 원장·환불/분쟁 회수·월 정산·지급 이력.
-- PayPal Payouts 는 별도 승인이 필요해 연동하지 않았다. 지급은 운영자가 송금 후 참조번호를 기록한다(external_ref).
ALTER TABLE affiliate_users ADD COLUMN payout_email TEXT;
ALTER TABLE affiliate_users ADD COLUMN approved_at TEXT;
ALTER TABLE affiliate_payouts ADD COLUMN external_ref TEXT;
ALTER TABLE affiliate_payouts ADD COLUMN paid_at TEXT;
ALTER TABLE affiliate_payouts ADD COLUMN note TEXT;
ALTER TABLE affiliate_referrals ADD COLUMN flag_reason TEXT;

-- 이미 정산(payable/paid)된 수수료의 원 결제가 환불·분쟁되면 음수 조정을 만들어 다음 정산에서 차감한다.
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
