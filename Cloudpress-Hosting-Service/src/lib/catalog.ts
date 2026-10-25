import { usd, type Micro } from "./money";

/** Cloudflare Containers 공식 인스턴스 타입(2026-10 문서 기준). 변경 시 문서 재검증 필요. */
export const OFFICIAL_INSTANCE_TYPES = {
  lite: { vcpu: 1 / 16, memoryMiB: 256, diskGB: 2 },
  basic: { vcpu: 1 / 4, memoryMiB: 1024, diskGB: 4 },
  "standard-1": { vcpu: 1 / 2, memoryMiB: 4096, diskGB: 8 },
  "standard-2": { vcpu: 1, memoryMiB: 6144, diskGB: 12 },
  "standard-3": { vcpu: 2, memoryMiB: 8192, diskGB: 16 },
  "standard-4": { vcpu: 4, memoryMiB: 12288, diskGB: 20 },
} as const;
export type InstanceType = keyof typeof OFFICIAL_INSTANCE_TYPES;

export type ProductKind = "ccs" | "cloudb" | "cloudb_sqlite" | "cloudb_pg" | "cloudage" | "csw" | "wordpress" | "cas";
export type DbEngine = "mariadb" | "mysql" | "postgres" | "sqlite";

export interface Product {
  id: string;
  kind: ProductKind;
  nameKo: string;
  monthlyMicro: Micro;
  /** 컨테이너 기반 상품만. 실제 할당 사양(공식 타입). */
  instanceType?: InstanceType;
  /** CPU 할당 목표(vCPU). 실제 할당과 구분해서 표시한다. */
  targetVcpu?: number;
  /** 월 포함 가동 시간(시간). undefined = 상시 가동 포함. */
  includedActiveHours?: number;
  includedStorageGB?: number;
  /** 포함 하위 서비스(중복 청구 금지). */
  includes?: ProductKind[];
  /** ClouDB 상품의 DB 엔진. */
  engine?: DbEngine;
  /** PostgreSQL 크기 등급. 제공자(Neon/Supabase)는 선택기가 결정한다. */
  pgSizeClass?: "micro" | "small" | "medium" | "large";
}

const P = (p: Product): Product => p;

/** 초기 시드 값. 운영에서는 D1(products/prices)이 원천이며 관리자가 변경한다. */
export const SEED_PRODUCTS: Product[] = [
  P({ id: "ccs-lite", kind: "ccs", nameKo: "CCS Lite", monthlyMicro: usd("4.99"), instanceType: "lite", targetVcpu: 1 / 16 }),
  P({ id: "ccs-basic", kind: "ccs", nameKo: "CCS Basic", monthlyMicro: usd("12.99"), instanceType: "basic", targetVcpu: 1 / 4 }),
  P({ id: "ccs-standard", kind: "ccs", nameKo: "CCS Standard", monthlyMicro: usd("34.99"), instanceType: "standard-1", targetVcpu: 1 / 2, includedActiveHours: 360 }),
  P({ id: "ccs-performance", kind: "ccs", nameKo: "CCS Performance", monthlyMicro: usd("59.99"), instanceType: "standard-3", targetVcpu: 2, includedActiveHours: 360 }),
  P({ id: "cloudb-mariadb", kind: "cloudb", nameKo: "ClouDB MariaDB", monthlyMicro: usd("12.99"), instanceType: "basic", targetVcpu: 1 / 4, includedStorageGB: 2, engine: "mariadb" }),
  P({ id: "cloudb-mysql", kind: "cloudb", nameKo: "ClouDB MySQL", monthlyMicro: usd("12.99"), instanceType: "basic", targetVcpu: 1 / 4, includedStorageGB: 2, engine: "mysql" }),
  P({ id: "cloudb-sqlite", kind: "cloudb_sqlite", nameKo: "ClouDB SQLite", monthlyMicro: usd("4.99"), includedStorageGB: 2, engine: "sqlite" }),
  P({ id: "cloudage-bucket", kind: "cloudage", nameKo: "Cloudage 버킷", monthlyMicro: usd("7.99"), includedStorageGB: 10 }),
  P({ id: "csw-service", kind: "csw", nameKo: "CSW 서비스", monthlyMicro: usd("4.99") }),
  P({ id: "wp-starter", kind: "wordpress", nameKo: "WordPress Starter", monthlyMicro: usd("19.99"), instanceType: "basic", targetVcpu: 1 / 4, includedStorageGB: 5, includes: ["ccs", "cloudb", "cloudage", "csw"] }),
  P({ id: "wp-pro", kind: "wordpress", nameKo: "WordPress Pro", monthlyMicro: usd("34.99"), instanceType: "standard-1", targetVcpu: 1 / 2, includedStorageGB: 20, includes: ["ccs", "cloudb", "cloudage", "csw"] }),
  P({ id: "wp-business", kind: "wordpress", nameKo: "WordPress Business", monthlyMicro: usd("59.99"), instanceType: "standard-2", targetVcpu: 1, includedStorageGB: 50, includes: ["ccs", "cloudb", "cloudage", "csw"] }),
  P({ id: "wp-scale", kind: "wordpress", nameKo: "WordPress Scale", monthlyMicro: usd("99.99"), instanceType: "standard-3", targetVcpu: 2, includedStorageGB: 100, includes: ["ccs", "cloudb", "cloudage", "csw"] }),
  P({ id: "cas-general", kind: "cas", nameKo: "CAS 일반 모델", monthlyMicro: usd("0.99") }),
  P({ id: "cas-performance", kind: "cas", nameKo: "CAS 고성능 모델", monthlyMicro: usd("2.99") }),
  P({ id: "cas-premium", kind: "cas", nameKo: "CAS 프리미엄 모델", monthlyMicro: usd("4.99") }),
  P({ id: "pg-micro", kind: "cloudb_pg", nameKo: "ClouDB PostgreSQL Micro", monthlyMicro: usd("19.99"), includedStorageGB: 8, engine: "postgres", pgSizeClass: "micro" }),
  P({ id: "pg-small", kind: "cloudb_pg", nameKo: "ClouDB PostgreSQL Small", monthlyMicro: usd("26.99"), includedStorageGB: 8, engine: "postgres", pgSizeClass: "small" }),
  P({ id: "pg-medium", kind: "cloudb_pg", nameKo: "ClouDB PostgreSQL Medium", monthlyMicro: usd("99.99"), includedStorageGB: 8, engine: "postgres", pgSizeClass: "medium" }),
  P({ id: "pg-large", kind: "cloudb_pg", nameKo: "ClouDB PostgreSQL Large", monthlyMicro: usd("179.99"), includedStorageGB: 8, engine: "postgres", pgSizeClass: "large" }),
];

export const WP_MULTISITE_MONTHLY: Micro = usd("4.00");

export interface CatalogIssue { productId: string; message: string }

/** 카탈로그가 공식 사양과 모순되지 않는지 검증한다(가짜 사양 판매 방지). */
export function validateCatalog(products: Product[]): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const ids = new Set<string>();
  for (const p of products) {
    if (ids.has(p.id)) issues.push({ productId: p.id, message: "중복 상품 ID" });
    ids.add(p.id);
    if (!Number.isInteger(p.monthlyMicro) || p.monthlyMicro <= 0) issues.push({ productId: p.id, message: "월 요금은 양의 정수(micro-USD)여야 함" });
    if (p.instanceType) {
      const spec = OFFICIAL_INSTANCE_TYPES[p.instanceType];
      if (!spec) issues.push({ productId: p.id, message: `미지원 인스턴스 타입: ${p.instanceType}` });
      else if (p.targetVcpu !== undefined && p.targetVcpu > spec.vcpu) issues.push({ productId: p.id, message: `CPU 목표(${p.targetVcpu})가 실제 할당(${spec.vcpu})보다 큼` });
    }
  }
  return issues;
}

export function getProduct(id: string, products: Product[] = SEED_PRODUCTS): Product {
  const p = products.find((x) => x.id === id);
  if (!p) throw new Error(`unknown product: ${id}`);
  return p;
}
