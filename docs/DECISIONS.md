# 설계 결정 기록

1. **CPU 사양**: Cloudflare Containers 공식 인스턴스 타입에 맞춰 상품을 재설계. 2 vCPU는 standard-3(Performance, WordPress Scale)만 해당. "목표 vCPU"와 "실제 vCPU"를 분리 저장.
2. **영속성**: 컨테이너 디스크는 캐시. 진실의 원천은 R2 백업(mariabackup+binlog 전송) + 네이티브 스냅샷(베타, 빠른 복구용).
3. **Supabase(Postgres)**: 별도 상품. WordPress는 MySQL 필요로 사용 불가. 재판매 약관 확인 필요(운영자).
4. **SLA**: 99.99%는 HA 티어에서 이중화 + 자체 SLA 엔진으로 추구. 계약 SLA는 90일 실측 후 승격.
5. **금액**: micro-USD 정수. 반올림은 청구 라인당 1회.
6. **GitHub**: 코드 저장소로만 사용. Actions/자동 배포 없음.
7. **인증**: PBKDF2-SHA256 100,000회(Workers WebCrypto 상한). 세션 토큰은 SHA-256 해시만 저장, `__Host-` 쿠키, CSRF 토큰(해시 저장)과 Origin 검사 병행. 로그인은 더미 해시로 사용자 존재 여부 노출 방지.
8. **웹훅**: 서명 검증(5분 허용) → `webhook_events` 이벤트 ID 멱등 → 처리. `checkout.session.completed` 는 ID 연결만, 활성화·프로비저닝은 `invoice.paid` 에서만. 순서 역전은 500 후 Stripe 재시도로 해소.
9. **아웃박스**: 큐 전송은 DB 작업 행(queued)을 기준으로 별도 전달(최소 1회). 소비자는 `idempotency_key` 로 멱등 처리.
10. **속도 제한**: 현재 MemoryRateLimiter 는 isolate 단위. 운영 전 Durable Object 구현으로 교체 필요(알려진 제한).
