# CloudPress - 통합 클라우드 호스팅 플랫폼

Cloudflare Workers, D1, Queues, R2, Containers 기반의 완전한 매니지드 호스팅 플랫폼입니다.

## 🏗 아키텍처

Cloudflare Workers, D1, Queues, R2, Containers 기반의 완전한 매니지드 호스팅 플랫폼입니다.

## 🚀 빠른 시작

### 사전 요구사항

- Node.js 20+
- Cloudflare 계정 (Workers, D1, R2, Queues, Containers 활성화)
- Stripe 계정 (결제 처리)
- GitHub 계정 (소스 관리)

### 1. 저장소 클론 및 설정

`ash
git clone https://github.com/choichoi3227-crypto/Cloudpress-Hosting-Service.git
cd Cloudpress-Hosting-Service
`

### 2. Cloudflare 리소스 생성

`ash
# D1 데이터베이스 생성 (개발/스테이징/프로덕션)
wrangler d1 create cloudpress-dev
wrangler d1 create cloudpress-staging
wrangler d1 create cloudpress-production

# 큐 생성
wrangler queues create cloudpress-jobs-dev
wrangler queues create cloudpress-jobs-staging
wrangler queues create cloudpress-jobs-production

# R2 버킷 생성 (백업/스토리지용)
wrangler r2 bucket create cloudpress-backups
wrangler r2 bucket create cloudpress-assets
`

### 3. 마이그레이션 실행

`ash
# 로컬 개발용 (SQLite)
wrangler d1 execute cloudpress-dev --local --file=./migrations/0001_init.sql
wrangler d1 execute cloudpress-dev --local --file=./migrations/0002_engines_rail_optimizer.sql
wrangler d1 execute cloudpress-dev --local --file=./migrations/0003_storage_recycling.sql
wrangler d1 execute cloudpress-dev --local --file=./migrations/0004_domains_zones.sql
wrangler d1 execute cloudpress-dev --local --file=./migrations/0005_fx_providers.sql
wrangler d1 execute cloudpress-dev --local --file=./migrations/0006_stripe_currency_jobs.sql
wrangler d1 execute cloudpress-dev --local --file=./migrations/0007_container_backup_snapshot.sql

# 원격 배포용
wrangler d1 execute cloudpress-dev --remote --file=./migrations/0001_init.sql
# ... 나머지 마이그레이션도 동일하게 실행
`

### 4. Secrets 설정 (필수!)

`ash
# 개발 환경
wrangler secret put STRIPE_WEBHOOK_SECRET --env dev
wrangler secret put STRIPE_SECRET_KEY --env dev
wrangler secret put SECRETS_ENCRYPTION_KEY --env dev
wrangler secret put CLOUDFLARE_API_TOKEN --env dev
wrangler secret put CLOUDFLARE_ACCOUNT_ID --env dev

# 스테이징
wrangler secret put STRIPE_WEBHOOK_SECRET --env staging
wrangler secret put STRIPE_SECRET_KEY --env staging
wrangler secret put SECRETS_ENCRYPTION_KEY --env staging
wrangler secret put CLOUDFLARE_API_TOKEN --env staging
wrangler secret put CLOUDFLARE_ACCOUNT_ID --env staging

# 프로덕션
wrangler secret put STRIPE_WEBHOOK_SECRET --env production
wrangler secret put STRIPE_SECRET_KEY --env production
wrangler secret put SECRETS_ENCRYPTION_KEY --env production
wrangler secret put CLOUDFLARE_API_TOKEN --env production
wrangler secret put CLOUDFLARE_ACCOUNT_ID --env production
`

### 5. 환경 변수 설정

`ash
# 프론트엔드용
cd frontend
cp .env.example .env
# PUBLIC_API_URL=https://your-worker.your-subdomain.workers.dev
`

### 6. 개발 서버 실행

`ash
# 백엔드 (별도 터미널)
wrangler dev --env dev

# 프론트엔드 (별도 터미널)
cd frontend
npm install
npm run dev
`

### 7. 배포

`ash
# 프론트엔드 빌드 + 백엔드 배포 (자동)
wrangler deploy --env production

# 또는 환경 지정
wrangler deploy --env staging
wrangler deploy --env dev
`

## 🔐 필수 Secrets 상세

| Secret Key | 설명 | 예시 값 | 필수 여부 |
|------------|------|---------|-----------|
| STRIPE_WEBHOOK_SECRET | Stripe 웹훅 서명 검증용 | whsec_... | 필수 |
| STRIPE_SECRET_KEY | Stripe API 호출용 Secret Key | sk_live_... 또는 sk_test_... | 필수 |
| STRIPE_API_VERSION | Stripe API 버전 고정 | 2024-06-20 | 필수 |
| SECRETS_ENCRYPTION_KEY | 32바이트 Base64 인코딩 암호화 키 | base64_encode(32_random_bytes) | 필수 |
| CLOUDFLARE_API_TOKEN | Cloudflare API 토큰 (Zone, DNS, Account 읽기/쓰기) | CF_API_TOKEN_... | 필수 |
| CLOUDFLARE_ACCOUNT_ID | Cloudflare 계정 ID | abc123... | 필수 |
| GABIA_CLIENT_ID | 가비아 파트너 API 클라이언트 ID | (가비아 파트너 시) | 선택 |
| GABIA_CLIENT_SECRET | 가비아 파트너 API 클라이언트 시크릿 | (가비아 파트너 시) | 선택 |
| SUPABASE_MANAGEMENT_TOKEN | Supabase Management API 토큰 | (PostgreSQL 상품용) | 선택 |
| NEON_API_KEY | Neon API 키 | (PostgreSQL 상품용) | 선택 |

### SECRETS_ENCRYPTION_KEY 생성 방법

`ash
# Linux/macOS
openssl rand -base64 32

# PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
`

## 🔧 Wrangler 설정 (wrangler.jsonc)

주요 설정 파일은 wrangler.jsonc를 참조하세요.

## 🗄 데이터베이스 스키마 (주요 테이블)

### 사용자 및 인증
- users - 사용자 계정 (role: customer/developer/engineer/manager/admin)
- user_sessions - 세션 관리 (토큰 해시, CSRF 해시)
- affiliate_users/referrals/commissions/payouts - 제휴 시스템

### 상품 및 구독
- products - 상품 카탈로그 (CCS, ClouDB, Cloudage, WordPress, CAS 등)
- prices - 가격 버저닝 (불변)
- subscriptions - 구독 상태 머신
- subscription_items - 구독 구성 아이템
- invoices/payments/refunds - 청구 및 결제

### 인프라
- containers - 컨테이너 인스턴스 (상태, 스펙, 스냅샷)
- container_instances - 실행 중인 인스턴스 상세
- container_images - 도커 이미지 버전 관리
- databases - DB 인스턴스 (엔진, 제공자, HA)
- storage_buckets - R2 버킷 (수명주기, 압축)
- dns_zones - Cloudflare 존 관리
- domain_orders - 도메인 주문/결제/등록

### 작업 큐
- deployment_jobs - 배포/프로비저닝 작업 (상태 머신)
- container_jobs - 컨테이너 전용 작업
- backup_jobs/chunks - 백업 작업 및 청크
- queue_jobs - 큐 메시지 추적

### 백업/스냅샷
- backup_jobs - 백업 작업 (전체/증분/binlog)
- backup_chunks - 암호화된 청크 (R2 저장)
- snapshots - Cloudflare 스냅샷 (30일 TTL)
- restore_jobs - 복원 작업

### 관리/감사
- admin_settings - 관리자 설정 (키-값)
- audit_logs - 감사 로그 (행위자, 행동, 대상, 상세)
- notifications - 알림 (사용자/운영자, 심각도)
- sla_probes/incidents - SLA 모니터링

## 🎨 프론트엔드 구조

frontend/
src/
pages/
index.astro           # 랜딩 페이지
login.astro           # 로그인
register.astro        # 회원가입
dashboard.astro       # 고객 대시보드
billing.astro         # 청구 관리
domains.astro         # 도메인 관리
services/
index.astro       # 서비스 목록
[id].astro        # 서비스 상세
admin/
index.astro       # 관리자 대시보드
scripts/                  # TypeScript 모듈 (esbuild 호환)
admin-dashboard.ts
billing.ts
dashboard.ts
domains.ts
login.ts
register.ts
security.ts
service-detail.ts
services.ts
lib/
api.ts                # API 클라이언트 (보안 포함)
components/ui/            # 재사용 UI 컴포넌트
layouts/Layout.astro      # 공통 레이아웃
styles/global.css         # Tailwind + 커스텀
astro.config.mjs              # output: 'static'
tailwind.config.mjs
package.json

## 🔑 권한 시스템 (RBAC)

| 역할 | 권한 |
|------|------|
| customer | 본인 서비스/도메인/청구 관리, 프로필 수정 |
| developer | 고객 권한 + API 문서 접근, 개발 도구 |
| engineer | 개발자 권한 + 컨테이너 관리, 배포 작업 승인 |
| manager | 엔지니어 권한 + 사용자 관리(정지/강등), 구독 강제 처리, 설정 변경 |
| admin | 모든 권한 + 사용자 블랙리스트, 리소스 압수, 시스템 설정, FX 환율 |

## 📦 상품 카탈로그

주요 상품들은 wrangler.jsonc 및 catalog.ts를 참조하세요.

## 🔄 작업 큐 및 스케줄러

### 크론 작업 (5분마다)
- 견적 만료 처리
- 구독 갱신/연체 처리
- 멈춘 작업 복구 (recoverStuckJobs)
- 아웃박스 메시지 전달
- 도메인 갱신 알림 (45일 전)
- SLA 프로브 실행
- 백업 스케줄 실행

### 작업 상태 머신
queued -> running -> succeeded
          \-> retrying (지수 백오프: 30s, 60s, 120s... 최대 1시간)
          \-> dead (최대 5회 실패 또는 영구 오류)

### 멱등성 보장
- 모든 작업은 idempotency_key로 중복 실행 방지
- 아웃박스 패턴으로 DB 트랜잭션 + 큐 전송 원자성 보장
- 큐 소비자는 항상 ack() 호출 (백오프 무력화 방지)

## 🌐 도메인 등록 시스템

### 지원 등록기관
1. Cloudflare Registrar (기본) - .com, .net, .org 등
2. Gabia (파트너 API) - .kr, .co.kr 등 한국 TLD

### 가격 정책
원가 + max(, 15%) + Stripe 수수료 보전 -> 센트 올림
- 한국 TLD(.kr)는 Gabia 강제 라우팅
- 갱신 비용 가중치 2배 적용 (장기 비용 최소화)
- 장애 시 타 등록기관 자동 페일오버

### 네임서버 위임
- 고객 도메인 -> Cloudflare 존 생성 (type=full)
- Cloudflare NS 안내 -> 고객 등록기관에서 변경
- 7일 미활성 존 자동 정리

## 💾 백업 및 스냅샷

### 백업 파이프라인
1. 컨테이너 내부 DB 덤프 (mariabackup/pg_dump)
2. 스트리밍 청크 분할 (5MB)
3. HKDF 파생 키로 AES-GCM 암호화
4. R2 업로드 (청크별 메타데이터 포함)
5. 매니페스트 SHA256 검증

### 보존 정책
- 전체 백업: 30일
- 증분 백업: 7일
- Binlog: 3일
- 스냅샷: 30일 TTL (복원 시 갱신), 최대 10개/컨테이너
- 복원 체인 보호: 가장 최근 Full + 이후 체인 유지

## 📊 모니터링 및 SLA

### SLA 목표
- 계약 SLA: 99.9% (90일 실측 후 99.99% 승격 목표)
- HA 티어: 이중화 + 자체 SLA 엔진으로 99.99% 추구

### 메트릭 수집
- 컨테이너: CPU, 메모리, 디스크, 요청수, P95 레이턴시, 에러율
- 도메인: DNS 응답, SSL 상태, 존 동기화
- 결제: Stripe 웹훅 성공률, 체크아웃 완료율

### 알림 채널
- 사용자: 이메일, 대시보드 알림
- 운영자: 크리티컬 알림 (Slack/이메일 연동 가능)

## 🛡 보안

### 인증
- PBKDF2-SHA256 (100,000회 반복)
- 세션 토큰 SHA-256 해시만 저장
- __Host- 접두사 쿠키, SameSite=Strict
- CSRF 토큰 (해시 저장) + Origin 검사

### 암호화
- AES-GCM (256비트) for secrets
- HKDF 키 파생 (백업 청크별 고유 키)
- TLS 1.2+ 강제 (Cloudflare Edge)

### 네트워크
- CSP: default-src 'none'; frame-ancestors 'none'
- HSTS: 2년 preload
- Rate Limiting: 메모리 기반 (운영 시 Durable Object로 교체 필요)

## 🚨 알려진 제한사항

1. Durable Object Rate Limiter 미구현 - 현재 메모리 기반 (isolate 단위)
2. Gabia 실 API 미연동 - 파트너 계약 및 API 명세 필요
3. 컨테이너 프로비저너 미구현 - provision/suspend/resume 작업은 폐기+운영자 알림
4. Stripe 한국 법인 미지원 - 한국 사업자 시 국내 PG(포트원/토스페이먼츠) 필요
5. Gabia API 명세 비공개 - 모의 구현만 되어 있음
6. 실제 컨테이너 이미지 미배포 - cloudpress/ccs-* 도커 이미지 필요
6. 프로비저너용 Durable Object 미구현 - 컨테이너 시작/중지 실제 API 연동 필요

## 📁 프로젝트 구조

Cloudpress-Hosting-Service/
src/
worker.ts                    # 메인 엔트리포인트
runtime.ts                   # 런타임 팩토리 (mock/live)
lib/                         # 핵심 비즈니스 로직 (30개 모듈)
frontend/                        # Astro + React + Tailwind
migrations/                      # D1 마이그레이션 (7개)
test/                            # Vitest 테스트 (24개 파일)
docs/DECISIONS.md                # 설계 결정 기록
wrangler.jsonc                   # Cloudflare 설정
tsconfig.json
package.json
README.md

## 🧪 테스트 실행

`ash
# 전체 테스트
npm run test

# 타입 체크
npm run typecheck

# 전체 검증
npm run check
`

## 📝 라이선스

MIT License - 자세한 내용은 LICENSE 참조

## 🤝 기여하기

1. Fork the repository
2. Create feature branch (git checkout -b feature/amazing-feature)
3. Commit changes (git commit -m 'Add amazing feature')
4. Push to branch (git push origin feature/amazing-feature)
5. Open Pull Request

## 📞 지원

- 이슈 리포팅: GitHub Issues
- 보안 이슈: security@cloudpress.example.com
- 문서: docs/DECISIONS.md

---

CloudPress - 차세대 클라우드 호스팅 플랫폼
Built with on Cloudflare Workers, D1, R2, Queues, Containers