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
  running: ["succeeded", "failed"],
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
