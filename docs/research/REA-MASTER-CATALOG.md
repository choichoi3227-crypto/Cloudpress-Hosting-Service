# REA Master Catalog - CloudPress

본 문서는 CloudPress 아키텍처 개선 및 기능 확장을 위해 REA(Reverse Engineering Anything) 도구 및 분석 기술을 활용하여 조사할 대상 목록을 정리한 카탈로그입니다.

## 1. 개요
*   **프로젝트:** CloudPress Hosting Service
*   **분석 중심:** Cloudflare 인프라, SaaS 결제 흐름, WordPress 호스팅 관리.

## 2. 조사 대상 카탈로그

| 제품/기술 | 카테고리 | 우선순위 | 목적 | REA 분석 방식 |
| :--- | :--- | :--- | :--- | :--- |
| **Cloudflare** | 인프라 | P0 | 인프라 리소스 최적화 | API 분석, 워크플로우 정적 분석 |
| **Stripe** | 결제 | P0 | 구독 및 과금 최적화 | 웹훅 로직 및 Checkout 분석 |
| **WordPress** | 호스팅 | P0 | 호스팅 호환성 및 기능 | 정적 분석 및 설정 검증 |
| **Plesk/cPanel** | 관리 패널 | P1 | 기능 벤치마킹 | API/구조 정적 분석 |
| **Docker/K8s** | 인프라 | P1 | 컨테이너 관리 최적화 | 컨테이너 런타임 분석 |

## 3. 접근 및 분석 상태
*   **분석 가능:** Cloudflare API, Stripe API, 로컬 코드 베이스 내 인프라 설정.
*   **제한적 분석:** 상용 호스팅 패널(Plesk 등)의 경우 문서 및 공개된 API 스펙 위주 분석.
