# REA Implementation Roadmap - CloudPress

## Phase 1: 현재 환경 기반 강화 (Priority: P0)
| 순위 | 작업 항목 | 예상 난이도 | 의존관계 | 검증 방법 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | REA MCP 도구 연동 확인 및 설정 문서화 | 낮음 | 없음 | `rea --version` 확인, MCP 세션 로그 |
| 2 | 분산 Rate Limiter 구현 (D1 기반) | 중간 | D1 스키마 존재 확인 | 부하 테스트, 동시성 확인 |
| 3 | 웹훅 이벤트 멱등성 키 인덱스 최적화 | 낮음 | migrations/0007_container_backup_s.sql 확인 | 웹훅 재전송 시 중복 처리 확인 |
| 4 | 컨테이너 헬스체크 엔드포인트 추가 | 중간 | containerManager.ts, LiveContainerManager | `/api/healthz` 혹은 커스텀 엔드포인트 |

## Phase 2: 관측성 및 모니터링 (Priority: P1)
| 순위 | 작업 항목 | 예상 난이도 | 의존관계 | 검증 방법 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | OpenTelemetry Workers 계측 추가 | 중간 | Wrangler 설정, 의존성 추가 | 트레이스/미터리 전송 확인 (Cloudflare Observability) |
| 2 | Grafana Cloud 대시보드 구성 | 중간 | OTel 계측 완료 | 대시보드에 지표 표시 확인 |
| 3 | SLA 프로브 자동화 (합성 모니터링) | 높음 | 모니터링 엔드포인트 존재 | 프로브 성공/실패 알림 확인 |

## Phase 3: 개발자 경험 개선 (Priority: P1)
| 순위 | 작업 항목 | 예상 난이도 | 의존관계 | 검증 방법 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `cloudpress` CLI 도구 개발 (배포, 로그, 디버그) | 높음 | Workers 빌드 스크립트, DB 마이그레이션 | 로컬 `npx cloudpress deploy` 실행 확인 |
| 2 | 로컬 개발 환경 구성 (miniflare + D1 로컬 + R2 로컬) | 중간 | miniflare, wrangler 설정 | `npm run dev` 또는 로컬 시뮬레이션 실행 |
| 3 | GitHub Actions 배포 파이프라인 템플릿 | 중간 | CI/CD 설정, 시크릿 관리 | PR merge 시 자동 배포 확인 |

## Phase 4: 멀티 리전/HA 강화 (Priority: P2)
| 순위 | 작업 항목 | 예상 난이도 | 의존관계 | 검증 방법 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | D1 리드 레플리카 구성 검토 | 높음 | D1 플랫폼 기능 제한 확인 | 레플리카 지연 시간 및 일관성 확인 |
| 2 | R2 멀티 버킷 리전 분산 | 중간 | R2 버킷 생성 및 설정 | 리전 간 데이터 동기화 확인 |
| 3 | 컨테이너 배치 다중 가용 영역 | 높음 | Cloudflare Containers 멀티 AZ 기능 | 컨테이너 장애 격리 테스트 |

## Phase 5: 보안 컴플라이언스 (Priority: P2)
| 순위 | 작업 항목 | 예상 난이도 | 의존관계 | 검증 방법 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | MFA(TOTP + WebAuthn) 지원 구현 | 높음 | 인증 라이브러리 선택, DB 스키마 확장 | 사용자 로그인 시 MFA 프롬프트 표시 |
| 2 | 키 순환 자동화 구현 | 중간 | KMS 또는 자체 구현 | 키 자동 교체 후 세션 지속성 확인 |
| 3 | 데이터 삭제권(GDPR) 자동화 스크립트 | 중간 | audit_logs, containers, databases 테이블 활용 | 삭제 요청 시 관련 리소스 자동 삭제 확인 |

## Phase 6: WordPress 특화 기능 (Priority: P3)
| 순위 | 작업 항목 | 예상 난이도 | 의존관계 | 검증 방법 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | WordPress 자동 설치/설정 스크립트 | 중간 | catalog.ts의 img-wp- 이미지 ID, containerManager | 컨테이너 생성 시 WordPress 기본 대시보드 접속 확인 |
| 2 | WP-CLI 기반 자동 업데이트 | 높음 | 워커 스크립트, 스케줄러 | 업데이트 후 플러그인/테마 호환성 확인 |
| 3 | EverCache 유사 캐시 전략 | 중간 | Cloudflare Workers Cache API | 페이지 로드 속도 향상 측정 |

## Phase 7: 멀티 레지스트라/도메인 고도화 (Priority: P3)
| 순위 | 작업 항목 | 예상 난이도 | 의존관계 | 검증 방법 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Registrar Router 에러 처리 강화 | 중간 | registrarRouter.ts, zoneService.ts | 레지스트라 응답 실패 시 대체 경로 자동 전환 |
| 2 | 도메인 소유권 검증 자동화 | 높음 | TXT 레코드 생성 + API 확인 | 도메인 추가 시 소유권 검증 완료 확인 |

