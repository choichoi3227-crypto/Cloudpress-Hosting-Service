import { sha256HexBytes } from "./crypto";
import type { Micro } from "./money";

/** 정산 단위(GB)는 십진 1,000,000,000 바이트로 가정. 실제 R2 정산 단위는 공식 문서로 재확인 필요. */
export const BYTES_PER_GB = 1_000_000_000;

export interface BucketOptPolicy {
  gzip: boolean;
  /** 손실 변환(AVIF/WebP). 고객 데이터를 바꾸므로 기본 꺼짐, 버킷별 명시적 동의 필요. */
  lossyImages: boolean;
  dedupe: boolean;
  tiering: boolean;
  minBytes: number;
  maxCompressBytes: number;
  minSavingRatio: number;
  minSsim: number;
}
export const DEFAULT_OPT_POLICY: BucketOptPolicy = { gzip: true, lossyImages: false, dedupe: true, tiering: true, minBytes: 1024, maxCompressBytes: 25 * 1024 * 1024, minSavingRatio: 0.1, minSsim: 0.97 };

export interface ObjectMeta { key: string; contentType: string; sizeBytes: number; alreadyOptimized?: boolean }

const COMPRESSIBLE = /^(text\/|application\/(json|xml|javascript|x-javascript|ld\+json|x-ndjson|sql|wasm|x-sh|x-yaml|yaml|rss\+xml|atom\+xml|xhtml\+xml)|image\/svg\+xml|font\/(ttf|otf)|application\/x-font-(ttf|otf))/i;
const ALREADY_COMPRESSED = /^(video\/|audio\/|image\/(jpeg|png|webp|avif|gif|heic)|font\/woff2?|application\/(zip|gzip|x-gzip|x-7z-compressed|x-rar|x-xz|zstd|x-bzip2|pdf|vnd\.openxmlformats-officedocument\.|epub\+zip|java-archive))/i;
const RASTER = /^image\/(jpeg|png)$/i;

export type OptAction = { action: "skip"; reason: string } | { action: "gzip"; reason: string } | { action: "image_transcode"; reason: string };

/** 객체별 최적화 결정. 이미 최적화됐거나 압축 불가·무의미한 객체는 건너뛰어 CPU와 Class A 작업 낭비를 막는다. */
export function planObject(m: ObjectMeta, p: BucketOptPolicy = DEFAULT_OPT_POLICY): OptAction {
  if (m.alreadyOptimized) return { action: "skip", reason: "이미 최적화됨(재처리 방지)" };
  if (m.sizeBytes < p.minBytes) return { action: "skip", reason: "너무 작아 이득 없음" };
  if (RASTER.test(m.contentType)) return p.lossyImages ? { action: "image_transcode", reason: "손실 변환 동의됨" } : { action: "skip", reason: "손실 변환 미동의(원본 보존)" };
  if (ALREADY_COMPRESSED.test(m.contentType)) return { action: "skip", reason: "이미 압축된 형식" };
  if (m.sizeBytes > p.maxCompressBytes) return { action: "skip", reason: "Worker CPU 한도 보호를 위해 대용량 제외" };
  if (p.gzip && COMPRESSIBLE.test(m.contentType)) return { action: "gzip", reason: "텍스트 계열 무손실 압축" };
  return { action: "skip", reason: "압축 대상 아님" };
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: { readable: ReadableStream<any>; writable: WritableStream<any> }): Promise<Uint8Array<ArrayBuffer>> {
  const w = stream.writable.getWriter();
  void w.write(bytes).then(() => w.close());
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
export const gzipBytes = (b: Uint8Array<ArrayBuffer>) => pipe(b, new CompressionStream("gzip"));
export const gunzipBytes = (b: Uint8Array<ArrayBuffer>) => pipe(b, new DecompressionStream("gzip"));

export interface GzipResult { accepted: boolean; stored: Uint8Array<ArrayBuffer>; encoding: "gzip" | "identity"; originalBytes: number; storedBytes: number; sha256: string; reason: string }

/** 무손실 압축. 복원 결과가 원본과 해시까지 같을 때만 채택하고, 절감률이 기준 미만이면 원본 유지. */
export async function optimizeGzip(original: Uint8Array<ArrayBuffer>, p: BucketOptPolicy = DEFAULT_OPT_POLICY): Promise<GzipResult> {
  const sha256 = await sha256HexBytes(original);
  const reject = (reason: string): GzipResult => ({ accepted: false, stored: original, encoding: "identity", originalBytes: original.length, storedBytes: original.length, sha256, reason });
  const gz = await gzipBytes(original);
  if (gz.length >= original.length * (1 - p.minSavingRatio)) return reject("절감률이 기준 미만");
  const back = await gunzipBytes(gz);
  if ((await sha256HexBytes(back)) !== sha256) return reject("복원 검증 실패(원본 유지)");
  return { accepted: true, stored: gz, encoding: "gzip", originalBytes: original.length, storedBytes: gz.length, sha256, reason: "압축·복원 검증 통과" };
}

export type ReadPlan = { serve: "raw" | "passthrough_gzip" | "decompress" | "decompress_then_slice" };
/** 읽기 경로: 클라이언트가 gzip 을 받을 수 있으면 압축본을 그대로 전달(CPU·대역폭 절약). Range 요청은 원본 기준이므로 풀어서 자른다. */
export function planRead(storedEncoding: "gzip" | "identity", acceptEncoding: string | null, hasRange: boolean): ReadPlan {
  if (storedEncoding === "identity") return { serve: "raw" };
  if (hasRange) return { serve: "decompress_then_slice" };
  return /\bgzip\b/i.test(acceptEncoding ?? "") ? { serve: "passthrough_gzip" } : { serve: "decompress" };
}

/* ── 손실 이미지 변환(포트 + 검증). 실제 인코더는 운영자가 선택(Cloudflare Images 또는 WASM) ── */
export interface ImageTranscoder { transcode(input: Uint8Array<ArrayBuffer>, target: "avif" | "webp", quality: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; width: number; height: number; ssim: number }> }

export async function optimizeImage(input: Uint8Array<ArrayBuffer>, dims: { width: number; height: number }, p: BucketOptPolicy, t: ImageTranscoder, target: "avif" | "webp" = "avif", quality = 0.8) {
  if (!p.lossyImages) return { accepted: false as const, reason: "손실 변환 미동의" };
  const out = await t.transcode(input, target, quality);
  if (out.width !== dims.width || out.height !== dims.height) return { accepted: false as const, reason: "해상도 불일치" };
  if (out.ssim < p.minSsim) return { accepted: false as const, reason: `화질 기준 미달(SSIM ${out.ssim} < ${p.minSsim})` };
  if (out.bytes.length >= input.length * (1 - p.minSavingRatio)) return { accepted: false as const, reason: "절감률이 기준 미만" };
  return { accepted: true as const, bytes: out.bytes, originalBytes: input.length, storedBytes: out.bytes.length, reason: "검증 통과" };
}

/* ── 버킷 내부 중복 제거(고객 간 중복 제거는 존재 여부 유출 위험이 있어 하지 않음) ── */
export function planDedupe(objs: { key: string; sha256: string; sizeBytes: number }[]) {
  const groups = new Map<string, { key: string; sizeBytes: number }[]>();
  for (const o of objs) groups.set(o.sha256, [...(groups.get(o.sha256) ?? []), { key: o.key, sizeBytes: o.sizeBytes }]);
  const dup = [...groups.entries()].filter(([, v]) => v.length > 1).map(([sha256, v]) => ({ sha256, keys: v.map((x) => x.key).sort(), savedBytes: v[0]!.sizeBytes * (v.length - 1) }));
  return { groups: dup, savedBytes: dup.reduce((a, g) => a + g.savedBytes, 0) };
}

/* ── 경제성 판단: 이득이 없으면 작업하지 않는다 ── */
export interface EconomicsInput {
  expectedSavedBytes: number;
  horizonMonths?: number;
  /** 계정 전체 물리 사용량이 무료 제공량 이내면 한계 저장 단가는 0 이다. */
  accountPhysicalBytes: number;
  freeTierBytes?: number;
  standardPerGBMonth?: Micro;
  classAPerOp?: Micro;
  classBPerOp?: Micro;
  cpuCostMicro?: Micro;
}
export function isWorthOptimizing(i: EconomicsInput): { worth: boolean; gainMicro: number; costMicro: number; reason: string } {
  const free = i.freeTierBytes ?? 10 * BYTES_PER_GB;
  const marginal = i.accountPhysicalBytes > free ? (i.standardPerGBMonth ?? 15_000) : 0;
  const gain = Math.round((i.expectedSavedBytes / BYTES_PER_GB) * marginal * (i.horizonMonths ?? 12));
  const cost = (i.classBPerOp ?? 0.36) + (i.classAPerOp ?? 4.5) + (i.cpuCostMicro ?? 0.5); // 읽기 1 + 쓰기 1 + CPU
  if (marginal === 0) return { worth: false, gainMicro: 0, costMicro: Math.round(cost), reason: "무료 제공량 이내: 절감해도 비용 이득 없음(작업 보류)" };
  return gain > cost ? { worth: true, gainMicro: gain, costMicro: Math.round(cost), reason: "기대 절감이 처리 비용을 초과" } : { worth: false, gainMicro: gain, costMicro: Math.round(cost), reason: "처리 비용이 절감액보다 큼" };
}

/* ── 저장 클래스(Infrequent Access) 전환: 30일 최소 보관, 조회 수수료 $0.01/GB, IA 쓰기 $9/M ── */
export function planTiering(o: { sizeBytes: number; daysSinceLastAccess: number; expectedReadsPerMonth: number; storageClass: "standard" | "ia" }): { move: boolean; reason: string; paybackMonths?: number } {
  if (o.storageClass === "ia") return { move: false, reason: "이미 IA" };
  if (o.daysSinceLastAccess < 60) return { move: false, reason: "최근 접근 이력(60일 미만)" };
  if (o.expectedReadsPerMonth > 0.2) return { move: false, reason: "읽기가 잦아 조회 수수료가 절감액을 상회할 수 있음" };
  const gb = o.sizeBytes / BYTES_PER_GB;
  const monthlySaving = gb * (15_000 - 10_000); // micro/월
  const moveCost = 9; // IA 로의 쓰기(Class A $9/M = 9 micro/op)
  const payback = monthlySaving > 0 ? moveCost / monthlySaving : Infinity;
  return payback <= 6 ? { move: true, reason: "회수 기간 6개월 이내", paybackMonths: payback } : { move: false, reason: "객체가 작아 전환 비용 회수 불가", paybackMonths: payback };
}
