# REA Architecture Plan - CloudPress 개선 아키텍처

## 1. 목표 아키텍처 원칙

1. **Cloudflare Native First**: Workers/D1/R2/Queues/Containers/Workers AI 최대한 활용
2. **Immutable Pricing**: 가격 버전 불변성 유지, 기존 구독 보호
3. **Tenant Isolation by Default**: 모든 리소스 접근 시 ownedBy 검증 필수
4. **Event-Driven Consistency**: Outbox 패턴으로 결과적 일관성 보장
5. **Observability Built-in**: 메트릭/로그/트레이스 기본 내장

## 2. 핵심 컴포넌트 아키텍처

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Workers    │  │  Containers  │  │    Queues    │              │
│  │  (API/SSR)   │  │  (Workloads) │  │  (Async Job) │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
└─────────┼─────────────────┼─────────────────┼──────────────────────┘
          │                 │                 │
    ┌─────┴─────┐     ┌─────┴─────┐     ┌─────┴─────┐
    │    D1     │     │    R2     │     │  Workers  │
    │ (Metadata)│     │ (Storage) │     │    AI     │
    └───────────┘     └───────────┘     └───────────┘
```

## 3. 데이터 플로우 개선안

### 3.1 컨테이너 프로비저닝 플로우 (개선)

```
사용자 요청 → Worker API → 유효성 검사 → D1 예약 레코드 생성
                                    ↓
                            Queue에 provision 잡 등록
                                    ↓
                            Queue Consumer (Worker)
                                    ↓
                            CfContainersClient.startContainer
                                    ↓
                            성공 시 D1 상태 업데이트 + Outbox 이벤트
                                    ↓
                            실패 시 재시도 (max 5회) → DLQ → 알림
```

### 3.2 결제/구독 동기화 플로우 (개선)

```
Stripe Webhook → Worker (검증) → Webhook Events 테이블 저장
                                    ↓
                            Outbox → Queue → Consumer
                                    ↓
                            로컬 DB 동기화 (멱등성 보장)
                                    ↓
                            구독 상태 변경 시 컨테이너 액션 트리거
```

## 4. 보안 강화 계획

| 영역 | 현재 | 목표 | 구현 방안 |
| :--- | :--- | :--- | :--- |
| **MFA** | 없음 | TOTP + WebAuthn | workers-auth 라이브러리 또는 자체 구현 |
| **키 관리** | 단일 SECRETS_ENCRYPTION_KEY | 키 버저닝 + 순환 | D1에 키 버전 저장, 주기적 순환 Job |
| **감사 로그** | 기본 저장 | 무결성 증명 + SIEM | 해시 체인 + Cloudflare Logpush |
| **속도 제한** | MemoryRateLimiter (단일 인스턴스) | 분산 속도 제한 | D1 기반 슬라이딩 윈도우 또는 CF Rate Limiting |

## 5. 비용 최적화 전략

1. **컨테이너 슬립 정책 고도화**: 유휴 감지 임계값 조정, 예측적 웜업
2. **R2 라이프사이클**: 백업 보관 주기 자동화, Glacier 유사 티어 활용
3. **D1 쿼리 최적화**: 인덱스 정비, materialized view로 집계 테이블 유지
4. **Workers CPU 시간**: 불필요한 직렬화/역직렬화 제거, 스트리밍 응답 활용

## 6. 마이그레이션 전략

### Phase 1: 기반 강화 (즉시)
- [ ] 분산 속도 제한 구현 (D1 기반)
- [ ] 웹훅 이벤트 멱등성 키 인덱스 추가
- [ ] 컨테이너 헬스체크 엔드포인트 표준화

### Phase 2: 관측성 (1-2주)
- [ ] OpenTelemetry Workers 계측
- [ ] Grafana Cloud 대시보드 구성
- [ ] SLA 프로브 자동화 (합성 모니터링)

### Phase 3: 개발자 경험 (2-4주)
- [ ] `cloudpress` CLI 도구 (배포, 로그, 디버그)
- [ ] 로컬 개발 환경 (miniflare + D1 로컬 + R2 로컬)
- [ ] GitHub Actions 배포 파이프라인 템플릿

### Phase 4: 멀티 리전/HA (장기)
- [ ] D1 리드 레플리카 구성 (가용 시)
- [ ] R2 다중 버킷 리전 분산
- [ ] 컨테이너 배치 다중 가용 영역

