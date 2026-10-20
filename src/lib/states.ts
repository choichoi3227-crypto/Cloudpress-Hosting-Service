/** 상태 전이 검증. 허용되지 않은 전이는 예외. D1 갱신 전에 서버에서 호출한다. */
type Transitions<S extends string> = Record<S, readonly S[]>;

export const SUBSCRIPTION_STATES = ["incomplete", "active", "past_due", "suspended", "canceling", "canceled", "refunded"] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];
export const SUBSCRIPTION_TRANSITIONS: Transitions<SubscriptionState> = {
  incomplete: ["active", "canceled"],
  active: ["past_due", "suspended", "canceling", "canceled", "refunded"],
  past_due: ["active", "suspended", "canceled"],
  suspended: ["active", "canceled"],
  canceling: ["active", "canceled"],
  canceled: [],
  refunded: [],
};

export const JOB_STATES = ["queued", "running", "succeeded", "failed", "retrying", "dead", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const JOB_TRANSITIONS: Transitions<JobState> = {
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "retrying", "dead"], // 실패 판정과 재시도/폐기 결정은 한 번에 기록
  failed: ["retrying", "dead"],
  retrying: ["running", "dead", "cancelled"],
  succeeded: [],
  dead: ["queued"], // 운영자 수동 재처리만 허용
  cancelled: [],
};

export const PAYOUT_STATES = ["pending", "approved", "paid", "failed", "rejected"] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];
export const PAYOUT_TRANSITIONS: Transitions<PayoutState> = {
  pending: ["approved", "rejected"],
  approved: ["paid", "failed"],
  failed: ["approved", "rejected"],
  paid: [],
  rejected: [],
};

export function assertTransition<S extends string>(table: Transitions<S>, from: S, to: S): void {
  if (!table[from]?.includes(to)) throw new Error(`illegal state transition: ${from} -> ${to}`);
}

export const DOMAIN_ORDER_STATES = ["awaiting_payment", "paid", "registering", "registered", "failed", "needs_review", "refund_due", "refunded", "quote_expired"] as const;
export type DomainOrderState = (typeof DOMAIN_ORDER_STATES)[number];
/** 등록은 환불 불가이므로 registering 이후 모호한 상태는 자동 재시도 대신 needs_review 로 보낸다. */
export const DOMAIN_ORDER_TRANSITIONS: Transitions<DomainOrderState> = {
  awaiting_payment: ["paid", "quote_expired"],
  quote_expired: ["paid"], // 만료 후 결제가 도착해도 원가 변동 검사 후 처리
  paid: ["registering", "refund_due"],
  registering: ["registered", "needs_review", "refund_due"],
  needs_review: ["registered", "refund_due"], // 운영자 판단
  refund_due: ["refunded"],
  registered: [],
  refunded: [],
  failed: [],
};
