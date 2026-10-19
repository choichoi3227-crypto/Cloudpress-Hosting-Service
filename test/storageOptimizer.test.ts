import { describe, it, expect } from "vitest";
import { planObject, optimizeGzip, gunzipBytes, planRead, optimizeImage, planDedupe, isWorthOptimizing, planTiering, DEFAULT_OPT_POLICY, BYTES_PER_GB, type ImageTranscoder } from "../src/lib/storageOptimizer";
import { sha256HexBytes } from "../src/lib/crypto";

const enc = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
const lorem = enc("CloudPress ".repeat(2000));

describe("객체 최적화 결정", () => {
  const m = (contentType: string, sizeBytes = 100_000, extra = {}) => ({ key: "k", contentType, sizeBytes, ...extra });
  it("텍스트 계열만 gzip, 이미 압축된 형식·소형·대용량·재처리는 건너뜀", () => {
    expect(planObject(m("text/html")).action).toBe("gzip");
    expect(planObject(m("application/json")).action).toBe("gzip");
    expect(planObject(m("image/svg+xml")).action).toBe("gzip");
    for (const t of ["image/webp", "image/avif", "video/mp4", "application/zip", "font/woff2", "application/pdf"]) expect(planObject(m(t)).action).toBe("skip");
    expect(planObject(m("text/html", 100)).action).toBe("skip");
    expect(planObject(m("text/html", 100 * 1024 * 1024)).action).toBe("skip");
    expect(planObject(m("text/html", 100_000, { alreadyOptimized: true })).action).toBe("skip");
  });
  it("JPEG/PNG 는 손실 변환 동의 없이는 절대 변환하지 않음(원본 보존)", () => {
    expect(planObject(m("image/jpeg")).action).toBe("skip");
    expect(planObject(m("image/jpeg"), { ...DEFAULT_OPT_POLICY, lossyImages: true }).action).toBe("image_transcode");
  });
});

describe("gzip 무손실 압축", () => {
  it("압축 후 복원하면 원본과 바이트 단위로 동일, 크기 감소", async () => {
    const r = await optimizeGzip(lorem);
    expect(r.accepted).toBe(true);
    expect(r.storedBytes).toBeLessThan(r.originalBytes * 0.9);
    const back = await gunzipBytes(r.stored);
    expect(await sha256HexBytes(back)).toBe(r.sha256);
  });
  it("무작위(압축 불가) 데이터는 원본 유지", async () => {
    const rnd = crypto.getRandomValues(new Uint8Array(20_000)) as Uint8Array<ArrayBuffer>;
    const r = await optimizeGzip(rnd);
    expect(r.accepted).toBe(false);
    expect(r.encoding).toBe("identity");
    expect(r.stored).toBe(rnd);
  });
  it("읽기 계획: gzip 가능 클라이언트에는 압축본 그대로, 아니면 해제, Range 는 해제 후 절단", () => {
    expect(planRead("identity", "gzip", false).serve).toBe("raw");
    expect(planRead("gzip", "br, gzip", false).serve).toBe("passthrough_gzip");
    expect(planRead("gzip", null, false).serve).toBe("decompress");
    expect(planRead("gzip", "gzip", true).serve).toBe("decompress_then_slice");
  });
});

describe("손실 이미지 변환 검증", () => {
  const img = new Uint8Array(100_000) as Uint8Array<ArrayBuffer>;
  const tc = (o: Partial<{ bytes: number; width: number; height: number; ssim: number }> = {}): ImageTranscoder => ({ transcode: async () => ({ bytes: new Uint8Array(o.bytes ?? 40_000) as Uint8Array<ArrayBuffer>, width: o.width ?? 800, height: o.height ?? 600, ssim: o.ssim ?? 0.99 }) });
  const lossy = { ...DEFAULT_OPT_POLICY, lossyImages: true };
  it("동의·해상도·화질·절감률 기준을 모두 통과해야 채택", async () => {
    expect((await optimizeImage(img, { width: 800, height: 600 }, lossy, tc())).accepted).toBe(true);
    expect((await optimizeImage(img, { width: 800, height: 600 }, DEFAULT_OPT_POLICY, tc())).accepted).toBe(false);
    expect((await optimizeImage(img, { width: 800, height: 600 }, lossy, tc({ width: 400 }))).accepted).toBe(false);
    expect((await optimizeImage(img, { width: 800, height: 600 }, lossy, tc({ ssim: 0.9 }))).accepted).toBe(false);
    expect((await optimizeImage(img, { width: 800, height: 600 }, lossy, tc({ bytes: 95_000 }))).accepted).toBe(false);
  });
});

describe("중복 제거·경제성·계층화", () => {
  it("버킷 내 동일 해시만 묶어 절감량 계산", () => {
    const r = planDedupe([{ key: "a", sha256: "h1", sizeBytes: 100 }, { key: "b", sha256: "h1", sizeBytes: 100 }, { key: "c", sha256: "h1", sizeBytes: 100 }, { key: "d", sha256: "h2", sizeBytes: 50 }]);
    expect(r.savedBytes).toBe(200);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.keys).toEqual(["a", "b", "c"]);
  });
  it("무료 제공량 이내에서는 절감해도 이득이 없으므로 작업하지 않음(낭비 방지)", () => {
    const r = isWorthOptimizing({ expectedSavedBytes: 5 * BYTES_PER_GB, accountPhysicalBytes: 8 * BYTES_PER_GB });
    expect(r.worth).toBe(false);
    expect(r.reason).toContain("무료");
  });
  it("무료 제공량 초과 후에는 절감이 처리 비용을 넘을 때만 수행", () => {
    expect(isWorthOptimizing({ expectedSavedBytes: 5 * BYTES_PER_GB, accountPhysicalBytes: 50 * BYTES_PER_GB }).worth).toBe(true);
    expect(isWorthOptimizing({ expectedSavedBytes: 1000, accountPhysicalBytes: 50 * BYTES_PER_GB }).worth).toBe(false);
  });
  it("IA 전환은 오래 안 쓰고 읽기가 드문 큰 객체만", () => {
    const base = { sizeBytes: 5 * BYTES_PER_GB, daysSinceLastAccess: 90, expectedReadsPerMonth: 0, storageClass: "standard" as const };
    expect(planTiering(base).move).toBe(true);
    expect(planTiering({ ...base, daysSinceLastAccess: 10 }).move).toBe(false);
    expect(planTiering({ ...base, expectedReadsPerMonth: 5 }).move).toBe(false);
    expect(planTiering({ ...base, sizeBytes: 2000 }).move).toBe(false);
    expect(planTiering({ ...base, storageClass: "ia" }).move).toBe(false);
  });
});
