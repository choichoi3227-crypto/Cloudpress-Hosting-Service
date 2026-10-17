# 설계 결정 기록

1. **CPU 사양**: Cloudflare Containers 공식 인스턴스 타입에 맞춰 상품을 재설계. 2 vCPU는 standard-3(Performance, WordPress Scale)만 해당. "목표 vCPU"와 "실제 vCPU"를 분리 저장.
2. **영속성**: 컨테이너 디스크는 캐시. 진실의 원천은 R2 백업(mariabackup+binlog 전송) + 네이티브 스냅샷(베타, 빠른 복구용).
3. **Supabase(Postgres)**: 별도 상품. WordPress는 MySQL 필요로 사용 불가. 재판매 약관 확인 필요(운영자).
4. **SLA**: 99.99%는 HA 티어에서 이중화 + 자체 SLA 엔진으로 추구. 계약 SLA는 90일 실측 후 승격.
5. **금액**: micro-USD 정수. 반올림은 청구 라인당 1회.
6. **GitHub**: 코드 저장소로만 사용. Actions/자동 배포 없음.
