import { usd, mulMilli, type Micro } from "./money";
import { OFFICIAL_INSTANCE_TYPES, type Product, getProduct, SEED_PRODUCTS } from "./catalog";

/** 모든 단가는 관리자 설정(D1 admin_settings)에서 로드한다. 아래는 초기 시드. */
export interface Rates {
  ccsMemoryPerGiBHour: Micro;
  ccsCpuPerVcpuMinute: Micro;
  ccsDiskPerGBHour: Micro;
  ccsEgressPerGB: Micro;
  cloudageExtraPerGB: Micro;
  cloudbExtraPerGB: Micro;
  cswPerMillionRequests: Micro;
  cswPerMillionCpuMs: Micro;
  cswIncludedRequests: number;
  cswIncludedCpuMs: number;
  casPer1kNeurons: { general: Micro; performance: Micro; premium: Micro };
}

export const SEED_RATES: Rates = {
  ccsMemoryPerGiBHour: usd("0.018"),
  ccsCpuPerVcpuMinute: usd("0.0025"),
  ccsDiskPerGBHour: usd("0.0005"),
  ccsEgressPerGB: usd("0.10"),
  cloudageExtraPerGB: usd("0.79"),
  cloudbExtraPerGB: usd("0.99"),
  cswPerMillionRequests: usd("0.75"),
  cswPerMillionCpuMs: usd("0.05"),
  cswIncludedRequests: 1_000_000,
  cswIncludedCpuMs: 10_000_000,
  casPer1kNeurons: { general: usd("0.02"), performance: usd("0.03"), premium: usd("0.04") },
};

export interface InvoiceLine { description: string; amountMicro: Micro }

/** Cloudage: 7.99 + max(0, GB-1) × 0.79. usageMilliGB = 사용량(GB)×1000 정수. */
export function cloudageMonthly(usageMilliGB: number, p: Product = getProduct("cloudage-bucket"), r: Rates = SEED_RATES): InvoiceLine[] {
  const includedMilli = (p.includedStorageGB ?? 1) * 1000;
  const extraMilli = Math.max(0, usageMilliGB - includedMilli);
  const lines: InvoiceLine[] = [{ description: `${p.nameKo} 기본 요금`, amountMicro: p.monthlyMicro }];
  if (extraMilli > 0) lines.push({ description: `추가 저장 공간 ${extraMilli / 1000} GB`, amountMicro: mulMilli(r.cloudageExtraPerGB, extraMilli) });
  return lines;
}

export interface CcsUsage {
  /** 해당 월 실제 가동 시간(밀리시간). */
  activeMilliHours: number;
  /** 활성 CPU 사용량(밀리 vCPU-분). */
  activeCpuMilliVcpuMinutes: number;
  egressMilliGB: number;
  /** 추가 CPU 구독(업그레이드) 사용 여부. true면 기본 포함분과 중복 청구하지 않도록 상위 타입 기준으로 계산. */
  upgradedFromProductId?: string;
}

/** CCS 초과 요금: 포함 가동 시간을 넘은 시간만 메모리·디스크를, CPU는 포함 CPU 초과분만 청구. */
export function ccsOverage(p: Product, u: CcsUsage, r: Rates = SEED_RATES): InvoiceLine[] {
  if (!p.instanceType) throw new Error("not a container product");
  const spec = OFFICIAL_INSTANCE_TYPES[p.instanceType];
  const lines: InvoiceLine[] = [];
  const includedMilliHours = p.includedActiveHours === undefined ? Number.POSITIVE_INFINITY : p.includedActiveHours * 1000;
  const overMilliHours = Math.max(0, u.activeMilliHours - includedMilliHours);
  if (overMilliHours > 0) {
    const memGiB = spec.memoryMiB / 1024;
    lines.push({ description: "초과 가동 메모리", amountMicro: mulMilli(Math.round(r.ccsMemoryPerGiBHour * memGiB), overMilliHours) });
    lines.push({ description: "초과 가동 디스크", amountMicro: mulMilli(r.ccsDiskPerGBHour * spec.diskGB, overMilliHours) });
  }
  // CPU는 활성 사용분 기준. 기본 포함 CPU 분(vCPU×포함시간×사용률)을 별도로 두지 않고 포함 가동 시간 내에서는 무과금.
  if (overMilliHours > 0 && u.activeMilliHours > 0) {
    const overShare = overMilliHours / u.activeMilliHours;
    const overCpu = Math.round(u.activeCpuMilliVcpuMinutes * overShare);
    if (overCpu > 0) lines.push({ description: "초과 활성 CPU", amountMicro: mulMilli(r.ccsCpuPerVcpuMinute, overCpu) });
  }
  if (u.egressMilliGB > 0) lines.push({ description: "네트워크 송신", amountMicro: mulMilli(r.ccsEgressPerGB, u.egressMilliGB) });
  return lines;
}

/** 추가 CPU = 상위 공식 타입으로의 전환. 요금은 상위 상품과 현재 상품의 차액(관리자 설정 가능한 상품 가격 기준). */
export function cpuUpgradeQuote(fromId: string, toId: string, products: Product[] = SEED_PRODUCTS) {
  const from = getProduct(fromId, products);
  const to = getProduct(toId, products);
  if (from.kind !== to.kind) throw new Error("서로 다른 상품군으로는 전환할 수 없음");
  if (!from.instanceType || !to.instanceType) throw new Error("컨테이너 기반 상품이 아님");
  const f = OFFICIAL_INSTANCE_TYPES[from.instanceType];
  const t = OFFICIAL_INSTANCE_TYPES[to.instanceType];
  if (t.vcpu <= f.vcpu) throw new Error("상위 CPU 타입이 아님(다운그레이드는 다음 갱신일부터 별도 처리)");
  return { deltaMicro: to.monthlyMicro - from.monthlyMicro, fromVcpu: f.vcpu, toVcpu: t.vcpu };
}

/** 중간 업그레이드 일할 계산. prorate=false 이면 다음 갱신일부터 전액. */
export function prorate(deltaMicro: Micro, remainingSeconds: number, periodSeconds: number, enabled: boolean): Micro {
  if (!enabled) return 0;
  if (periodSeconds <= 0 || remainingSeconds < 0 || remainingSeconds > periodSeconds) throw new Error("invalid period");
  return Math.round((deltaMicro * remainingSeconds) / periodSeconds);
}

/** CSW 초과 요금. */
export function cswOverage(requests: number, cpuMs: number, r: Rates = SEED_RATES): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  const overReq = Math.max(0, requests - r.cswIncludedRequests);
  const overCpu = Math.max(0, cpuMs - r.cswIncludedCpuMs);
  if (overReq > 0) lines.push({ description: "초과 요청", amountMicro: Math.round((overReq * r.cswPerMillionRequests) / 1_000_000) });
  if (overCpu > 0) lines.push({ description: "초과 CPU 시간", amountMicro: Math.round((overCpu * r.cswPerMillionCpuMs) / 1_000_000) });
  return lines;
}

/** CAS 사용량 과금: Neurons 기반. 1,000 Neurons당 단가. */
export function casUsage(tier: "general" | "performance" | "premium", neurons: number, r: Rates = SEED_RATES): Micro {
  return Math.round((neurons * r.casPer1kNeurons[tier]) / 1000);
}

export function sumLines(lines: InvoiceLine[]): Micro {
  return lines.reduce((a, l) => a + l.amountMicro, 0);
}

/** WordPress 포함 서비스는 중복 청구하지 않는다: 통합 상품 가격만 청구하고 포함 용량 초과분만 별도. */
export function wordpressMonthly(p: Product, usedStorageMilliGB: number, r: Rates = SEED_RATES): InvoiceLine[] {
  if (p.kind !== "wordpress") throw new Error("not a wordpress product");
  const lines: InvoiceLine[] = [{ description: p.nameKo, amountMicro: p.monthlyMicro }];
  const extra = Math.max(0, usedStorageMilliGB - (p.includedStorageGB ?? 0) * 1000);
  if (extra > 0) lines.push({ description: `포함 용량 초과 ${extra / 1000} GB`, amountMicro: mulMilli(r.cloudageExtraPerGB, extra) });
  return lines;
}
