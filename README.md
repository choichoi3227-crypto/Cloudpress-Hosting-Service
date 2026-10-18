# Cloudpress-Hosting-Service

#1. **실시간 설계 결정 기록(신규 작업 완료 즉시 데이터 반영)**

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
11. **ClouDB 다중 엔진**: MariaDB·MySQL(컨테이너+R2 백업), SQLite(D1 기반, 컨테이너 불필요), PostgreSQL(Neon 또는 Supabase). 엔진-제공자 조합은 D1 CHECK 제약으로 강제.
12. **PostgreSQL 제공자 선택**: 비용(50)·성능(30)·신뢰도(20) 가중 점수(관리자 변경 가능). 동점은 Neon 우선. 실측 전 가정값(Neon 재개 지연 800ms, 두 제공자 신뢰도 동일)은 벤치마크 작업으로 교체해야 함. 플랜별 프로젝트 수 상한(Neon Launch 100/Scale 1,000)은 2차 자료 기준이라 공식 확인 필요.
13. **Supabase의 역할**: "캐시"가 아니라 교차 제공자 HA 보조(복제본). 유료 Postgres를 캐시로 쓰면 낭비이므로 읽기 캐시는 Workers Cache/KV. 제공자 간 논리 복제의 실제 동작(DDL·시퀀스 미복제, 장애 전환 시 펜싱)은 스테이징에서 검증해야 함.
14. **플랫폼 메타데이터 DB**: 기존 D1 유지(명령서 규정, 구현·테스트 완료). Neon 은 고객용 PostgreSQL 상품의 주 제공자로 사용.
15. **최적화 원칙**: 성능 보호가 비용 절감보다 우선(OOM·스로틀·재시작이 있으면 하향 금지, 콜드 스타트 예산 준수, 상태 저장 서비스는 절전 금지). 자동 삭제 금지(삭제는 검토 요청 + 2단계 확인), 유료 플랜 변경은 고객 승인 필요(권고만 생성).
16. **Cloudage 기본 제공량 10GB**: 월 $7.99 기본료는 유지, 초과분 $0.79/GB. 단, 초과 단가가 R2 원가(약 $0.015/GB-월) 대비 매우 높아 합리성 재검토 권장(관리자 설정으로 변경 가능).
