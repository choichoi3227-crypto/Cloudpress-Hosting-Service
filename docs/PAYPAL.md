# PayPal 결제 전환 안내 (Stripe 대체)

결제는 100% PayPal 로 처리한다. Stripe 코드는 제거했다(과거 데이터 보존을 위해 DB 의 `stripe_*` 컬럼만 남김).

## 방식
| 항목 | 구현 |
|---|---|
| 월 구독 | PayPal Subscriptions API(Plan → Subscription). 가격 버전마다 별도 Plan 을 만들어 기존 구독 가격이 바뀌지 않는다 |
| 결제 확정 | **웹훅(`PAYMENT.SALE.COMPLETED`)으로만** 확정. 리턴 URL 쿼리값은 믿지 않는다 |
| 도메인(일회성) | Orders API v2. 리턴 시 서버가 캡처하고 금액·주문을 재검증, 웹훅(`PAYMENT.CAPTURE.COMPLETED`)이 같은 처리를 멱등하게 수행 |
| 서명 검증 | PayPal `verify-webhook-signature` API (`PAYPAL_WEBHOOK_ID` 필요) |
| 환불 | Payments v2 `captures/{id}/refund`, 환불·분쟁 웹훅이 DB 에 반영 |
| 취소 | PayPal 구독 해지(다음 결제 중단) + 이미 결제한 기간은 유지(`canceling`) → 기간 종료 시 스케줄러가 `canceled` 확정 |
| 고객 포털 | PayPal 에는 없음 → PayPal 계정의 자동결제 관리 페이지로 안내 |

## 웹훅 등록
PayPal 개발자 대시보드 → 앱 → Webhooks → `https://<도메인>/api/webhooks/paypal`, 이벤트:
`BILLING.SUBSCRIPTION.ACTIVATED / SUSPENDED / CANCELLED / EXPIRED / PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED / REFUNDED / REVERSED`, `PAYMENT.CAPTURE.COMPLETED / REFUNDED / REVERSED`, `CUSTOMER.DISPUTE.CREATED`.
발급된 Webhook ID 를 `PAYPAL_WEBHOOK_ID` 로 등록한다.

## 반드시 알아야 할 제약 (공식 안내 확인)
1. **KRW 결제 불가** — PayPal 결제 통화에 KRW 가 없어 USD 만 받는다. 환율 기반 원화 가격 기능은 결제에서 쓰지 않는다.
2. **한국 계정은 한국 밖 구매자만** — 한국에 등록된 PayPal 계정은 한국 국내 구매자의 결제를 받을 수 없다. 한국 고객 대상 서비스라면 사실상 판매가 막힌다. 국내 고객이 목표면 국내 PG 병행이 필요하다.
3. **제휴 수수료 지급** — Stripe Connect 가 없다. PayPal Payouts(별도 신청·승인 필요)로 지급해야 하며 아직 구현하지 않았다. 지급 승인 후 수동 송금이 현재 안전한 방법이다.
4. **수수료 가정치** — `domainPricing.ts` 의 4.4% + $0.30 은 추정값이다. 실제 계약 수수료로 조정할 것.
5. 구독 이용 기간은 결제 시각 기준 +1개월(UTC)로 기록한다. PayPal 의 다음 결제일과 며칠 어긋날 수 있다.

## 필요한 Secrets
`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` (+ `PAYPAL_ENV=sandbox|live`). 마이그레이션 `0010_paypal.sql` 적용 필요.
