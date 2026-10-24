# REA Comparison Analysis - CloudPress vs Industry Standards

## 1. Container Orchestration Comparison

| 기능 | CloudPress (현재) | Cloudflare Containers | Plesk/Docker | Kubernetes |
| :--- | :--- | :--- | :--- | :--- |
| **스케줄링 정책** | 인스턴스 타입별 분기 (lite/basic=default, 이상=durable_object) | Durable Object 기반 자동 배치 | Docker Swarm/자체 스케줄러 | 고급 스케줄러 (affinity, taints, topology) |
| **스냅샷/백업** | durable_object만 지원, R2 저장 | DO 기반 스냅샷 기본 제공 | 컨테이너 커밋/볼륨 스냅샷 | CSI 드라이버 기반 볼륨 스냅샷 |
| **리사이징** | durable_object만, 무중단 전환 로직 단순화 | 인스턴스 타입 변경 시 재배치 | 컨테이너 재생성 필요 | Rolling update, in-place resize(일부) |
| **네트워크 격리** | interceptOutboundHttp로 내부 엔드포인트만 허용 | VPC 유사 격리, 커스텀 인터셉트 | 브리지/오버레이 네트워크 | CNI 플러그인 기반 고급 격리 |
| **메트릭 수집** | collectHostMetrics() 시뮬레이션 | 플랫폼 메트릭 제공 예정 | cAdvisor, Prometheus | kube-state-metrics, Prometheus |

**분석 결과:** CloudPress의 이중 정책(default/durable_object)은 비용 최적화에 유리하나, 운영 복잡도 증가. durable_object 정책으로 통합하고 lite/basic도 소규모 DO로 처리하는 방향 검토 필요.

## 2. 결제 및 구독 비교

| 기능 | CloudPress (현재) | Stripe Billing | Plesk/WHMCS | AWS Marketplace |
| :--- | :--- | :--- | :--- | :--- |
| **가격 버전 관리** | prices 테이블 버저닝, 기존 구독 유지 | Price 객체 버저닝, subscription_items | 상품별 고정 가격, 업그레이드 수동 | 프라이빗 오퍼, 계약 단위 |
| **사용량 기반 과금** | usage_records + aggregates, 멱등키 기반 | Metered billing, usage records | 제한적 (트래픽/디스크 별도) | 세분화된 사용량 리포트 |
| **웹훅 처리** | idempotency + outbox 패턴, 재시도 큐 | 재시도 + 서명 검증 | 수동 동기화 위주 | SNS/SQS 기반 이벤트 |
| **다중 통화** | USD 고정, FX 레이트 별도 저장 | 135+ 통화 네이티브 지원 | 통화별 가격 설정 | USD 청구서, 현지 통화 표시 |

**분석 결과:** Stripe 네이티브 Metered Billing 도입 시 usage_records/aggregates 테이블 단순화 가능. 단, CloudPress의 마이크로-USD 정수 연산 정밀도 유지 필요.

## 3. 도메인/DNS 관리 비교

| 기능 | CloudPress (현재) | Cloudflare Registrar | Plesk/DirectAdmin | Route53/GoDaddy |
| :--- | :--- | :--- | :--- | :--- |
| **등록/이전** | registrarRouter로 다중 레지스트라 지원 | Cloudflare Registrar만 (도매가) | eNom/LogicBoxes/ResellerClub | 자체/리셀러 |
| **DNS 레코드** | zones 테이블 + zoneService, Custom Hostname | Cloudflare DNS 네이티브 | BIND/PowerDNS 백엔드 | Route53, 표준 DNS |
| **SSL/TLS** | Custom Hostname + 자동 갱신 | Universal SSL + Custom Hostname | Let's Encrypt 자동, 유료 인증서 | ACM, 유료 인증서 |
| **소유권 검증** | TXT 레코드 토큰 검증 | 이메일/DNS/HTTP 검증 | 이메일/DNS 검증 | 이메일/DNS 검증 |

**분석 결과:** Cloudflare Registrar 도매가 이점 활용 중. 다중 레지스트라 라우터(registrarRouter)는 복원력 확보에 유리하나, 에러 처리 및 상태 동기화 로직 강화 필요.

## 4. WordPress 호스팅 특화 비교

| 기능 | CloudPress (예정/구현중) | WP Engine/Kinsta | RunCloud/CloudPanel | Plesk WordPress Toolkit |
| :--- | :--- | :--- | :--- | :--- |
| **자동 설치** | 컨테이너 이미지 기반 (img-wp-) | 원클릭, 스테이징 포함 | Docker 이미지/스크립트 | 원클릭 + 복제/스테이징 |
| **자동 업데이트** | 컨테이너 재배포 전략 필요 | 코어/플러그인/테마 자동 | WP-CLI 크론 | 스마트 업데이트 (비주얼 회귀) |
| **캐시/성능** | Cloudflare Cache + Workers | EverCache, Nginx + Redis | Nginx + Redis + Varnish | Nginx + Redis, WP Rocket 연동 |
| **보안** | 컨테이너 격리, intercept 차단 | WAF, 악성코드 스캔, 2FA | Fail2ban, ModSecurity | WordPress Toolkit 보안 스캔 |
| **백업/복원** | 컨테이너 스냅샷 + DB 덤프 | 일일 자동, 온디맨드, 포인트인타임 | 스냅샷 + DB 덤프 | 증분 백업, 원클릭 복원 |

**분석 결과:** CloudPress의 컨테이너 기반 접근은 격리성/이식성에서 강점. 단, WordPress 생태계(플러그인/테마 호환성, WP-CLI 자동화) 도구 체인 통합이 관건.

## 5. 보안 아키텍처 비교

| 영역 | CloudPress | 업계 표준 (SOC2/ISO27001) |
| :--- | :--- | :--- |
| **인증** | 세션 쿠키(HttpOnly, Secure, SameSite=Lax), CSRF 토큰, 타이밍 공격 방지 | 동일 + MFA, 패스키, 세션 고정 방지 |
| **권한** | 서버 사이드 role 체크, ownedBy 격리 | RBAC/ABAC, Just-In-Time 액세스 |
| **암호화** | SECRETS_ENCRYPTION_KEY, R2 암호화 | KMS/HSM, 키 순환, 엔벨로프 암호화 |
| **감사** | audit_logs 테이블, IP 해시 | 불변 로그, SIEM 연동, 실시간 알림 |
| **네트워크** | interceptOutboundHttp, 내부만 허용 | 제로 트러스트, mTLS, 서비스 메시 |

**개선 필요:** MFA 지원, 비밀번호리스 로그인(Passkey), 키 순환 자동화, 감사 로그 무결성 증명(해시 체인).

## 6. 요약: CloudPress 차별화 포인트 및 격차

### 강점 (유지/강화)
1. **Cloudflare 네이티브**: Workers/D1/R2/Containers/Queues 통합으로 운영 오버헤드 최소화
2. **가격 버전 불변성**: 기존 구독 보호, 투명한 가격 변경 이력
3. **테넌트 격리**: ownedBy 패턴, 컨테이너/DB/스토리지 레벨 격리
4. **아웃박스 패턴**: 이벤트 기반 아키텍처로 결과적 일관성 보장

### 격차 (보완 필요)
1. **관측성**: 메트릭/로그/트레이싱 통합 대시보드 부재 (Grafana Cloud 연동 검토)
2. **재해 복구**: RPO/RTO 정의, 교차 리전 백업, 복구 훈련 자동화
3. **개발자 경험**: CLI 도구, 로컬 개발 환경(미니 Cloudflare), 배포 파이프라인
4. **멀티 리전**: 현재 단일 계정/리전, 장애 도메인 분산 전략 필요
5. **컴플라이언스**: 데이터 레지던시, GDPR 삭제권 자동화, SOC2 증거 수집

