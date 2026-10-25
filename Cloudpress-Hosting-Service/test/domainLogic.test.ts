import { describe, it, expect } from "vitest";
import { usd } from "../src/lib/money";
import { normalizeHostname, isApexDomain } from "../src/lib/domainNames";
import { validateRecord, checkConflicts, toFqdn, type DnsRecord } from "../src/lib/dnsRecords";
import { planSettings, validateRule, SETTINGS, PRESETS } from "../src/lib/zoneSettings";
import { priceFor, netMarginMicro, driftAcceptable, renewalState, SEED_DOMAIN_PRICING } from "../src/lib/domainPricing";
import { decideImageRewrite, imageRewritePaybackMonths, allocateTransformBudget, BYTES_PER_GB } from "../src/lib/storageOptimizer";
import { CfClient, CfApiError, type FetchLike } from "../src/lib/cfApi";
import { CloudflareRegistrar } from "../src/lib/registrar";

describe("도메인 이름", () => {
  it("정규화: 대소문자·후행 점·IDN(punycode)", () => {
    expect(normalizeHostname("Example.COM.")).toBe("example.com");
    expect(normalizeHostname("한글.kr")).toBe("xn--bj0bj06e.kr");
  });
  it("잘못된 입력 거부: 경로·포트·공백·IP·라벨 오류", () => {
    for (const bad of ["", "localhost", "a b.com", "http://x.com/p", "x.com:80", "1.2.3.4", "-a.com", "a..com", "a".repeat(64) + ".com", "x@y.com"]) expect(normalizeHostname(bad), bad).toBeNull();
  });
  it("루트 도메인 판정(.co.kr 포함)", () => {
    expect(isApexDomain("example.com")).toBe(true);
    expect(isApexDomain("www.example.com")).toBe(false);
    expect(isApexDomain("example.co.kr")).toBe(true);
    expect(isApexDomain("shop.example.co.kr")).toBe(false);
    expect(isApexDomain("example.kr")).toBe(true);
  });
});

describe("DNS 레코드 검증", () => {
  const z = "example.com";
  const ok = (r: any) => validateRecord(z, r);
  it("이름 정규화(@, 상대 이름, 영역 밖 거부)", () => {
    expect(toFqdn("@", z)).toBe(z);
    expect(toFqdn("www", z)).toBe("www.example.com");
    expect(toFqdn("a.example.com", z)).toBe("a.example.com");
    expect(toFqdn("bad name", z)).toBeNull();
    expect(toFqdn("*.api", z)).toBe("*.api.example.com");
    expect(toFqdn("a.*.b", z)).toBeNull();
  });
  it("A/AAAA 형식과 프록시 대상의 사설·예약 IP 금지", () => {
    expect(ok({ type: "A", name: "@", content: "203.0.113.5" }).ok).toBe(true);
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.1.1", "100.64.0.1", "224.0.0.1", "0.0.0.0"]) expect(ok({ type: "A", name: "@", content: ip, proxied: true }).ok, ip).toBe(false);
    expect(ok({ type: "A", name: "@", content: "10.0.0.1" }).ok).toBe(true); // 비프록시 내부 IP 는 DNS 응답일 뿐
    expect(ok({ type: "A", name: "@", content: "300.1.1.1" }).ok).toBe(false);
    expect(ok({ type: "A", name: "@", content: "01.2.3.4" }).ok).toBe(false);
    expect(ok({ type: "AAAA", name: "@", content: "2001:db8::1" }).ok).toBe(true);
    expect(ok({ type: "AAAA", name: "@", content: "2001:db8:::1" }).ok).toBe(false);
    expect(ok({ type: "AAAA", name: "@", content: "::1", proxied: true }).ok).toBe(false);
  });
  it("프록시·TTL 규칙", () => {
    expect(ok({ type: "TXT", name: "@", content: "v=spf1", proxied: true }).ok).toBe(false);
    expect(ok({ type: "A", name: "@", content: "1.2.3.4", ttl: 30 }).ok).toBe(false);
    expect(ok({ type: "A", name: "@", content: "1.2.3.4", ttl: 300 }).ok).toBe(true);
    expect(ok({ type: "A", name: "@", content: "1.2.3.4", proxied: true, ttl: 300 }).ok).toBe(false);
    const p = ok({ type: "A", name: "@", content: "1.2.3.4", proxied: true });
    expect(p.ok && p.record.ttl).toBe(1);
  });
  it("MX·SRV·CAA·TXT·NS", () => {
    expect(ok({ type: "MX", name: "@", content: "mail.example.com", priority: 10 }).ok).toBe(true);
    expect(ok({ type: "MX", name: "@", content: "mail.example.com" }).ok).toBe(false);
    expect(ok({ type: "SRV", name: "_sip._tcp", content: "5 5060 sip.example.com", priority: 10 }).ok).toBe(true);
    expect(ok({ type: "SRV", name: "sip", content: "5 5060 sip.example.com", priority: 10 }).ok).toBe(false);
    expect(ok({ type: "CAA", name: "@", content: '0 issue "letsencrypt.org"' }).ok).toBe(true);
    expect(ok({ type: "CAA", name: "@", content: "garbage" }).ok).toBe(false);
    expect(ok({ type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none" }).ok).toBe(true);
    expect(ok({ type: "TXT", name: "@", content: "x".repeat(2049) }).ok).toBe(false);
    expect(ok({ type: "NS", name: "@", content: "ns.evil.com" }).ok).toBe(false); // apex NS 변경 금지
    expect(ok({ type: "NS", name: "sub", content: "ns.other.com" }).ok).toBe(true);
    expect(ok({ type: "PTR" as any, name: "@", content: "x" }).ok).toBe(false);
  });
  it("충돌: CNAME 단독, 중복, 개수 상한", () => {
    const ex: DnsRecord[] = [{ id: "1", type: "A", name: "www.example.com", content: "1.2.3.4", ttl: 1, proxied: false }];
    const cname = { type: "CNAME" as const, name: "www.example.com", content: "x.example.net", ttl: 1, proxied: false };
    expect(checkConflicts(ex, cname, 200)).toContain("CNAME");
    expect(checkConflicts([{ ...cname, id: "2" }], ex[0]!, 200)).toContain("CNAME");
    expect(checkConflicts(ex, { ...ex[0]!, id: undefined }, 200)).toContain("동일");
    expect(checkConflicts(ex, { ...ex[0]!, content: "5.6.7.8", id: undefined }, 200)).toBeNull(); // 라운드 로빈 A 는 허용
    expect(checkConflicts(ex, { ...ex[0]!, content: "5.6.7.8" }, 1)).toContain("최대");
  });
});

describe("영역 설정·규칙", () => {
  it("취약한 값은 허용 안 함(ssl off, TLS 1.0, 모르는 키)", () => {
    const p = planSettings({}, { ssl: "off", min_tls_version: "1.0", bogus: "on", always_use_https: "on", browser_cache_ttl: 12345 });
    expect(p.changes).toEqual([{ key: "always_use_https", value: "on" }]);
    expect(p.rejected.map((r) => r.key).sort()).toEqual(["bogus", "browser_cache_ttl", "min_tls_version", "ssl"]);
  });
  it("바뀌지 않은 값은 호출 대상에서 제외(API 호출 최소화)", () => {
    const p = planSettings({ http3: "on", brotli: "off" }, { http3: "on", brotli: "on" });
    expect(p.unchanged).toEqual(["http3"]);
    expect(p.changes).toEqual([{ key: "brotli", value: "on" }]);
  });
  it("모든 프리셋은 카탈로그 검증을 통과", () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const p = planSettings({}, preset);
      expect(p.rejected, name).toEqual([]);
    }
    expect(SETTINGS["dnssec"]!.kind).toBe("dnssec");
  });
  it("규칙 검증: 단계·동작·한도·표현식", () => {
    const r = { expression: '(http.request.uri.path contains "/admin")', action: "block" };
    expect(validateRule("http_request_firewall_custom", r, 0)).toBeNull();
    expect(validateRule("http_request_firewall_custom", r, 5)).toContain("최대 5개");
    expect(validateRule("http_request_firewall_custom", { ...r, action: "skip" }, 0)).toContain("허용되지 않는 동작");
    expect(validateRule("bogus_phase", r, 0)).toContain("단계");
    expect(validateRule("http_request_dynamic_redirect", { expression: "", action: "redirect" }, 0)).toContain("표현식");
    expect(validateRule("http_request_dynamic_redirect", { expression: "x".repeat(5000), action: "redirect" }, 0)).toContain("표현식");
  });
});

describe("도메인 가격·갱신", () => {
  it("수수료 하한 보장: 결제 수수료를 빼고도 최소 수수료 이상 남음(다양한 원가)", () => {
    for (const c of ["1.00", "8.57", "10.44", "35.00", "99.99", "250.00"]) {
      const cost = usd(c);
      const price = priceFor(cost);
      expect(netMarginMicro(price, cost)).toBeGreaterThanOrEqual(SEED_DOMAIN_PRICING.minFeeMicro - 10_000);
      expect(price % 10_000).toBe(0); // 센트 단위
      expect(price).toBeGreaterThan(cost);
    }
  });
  it("원가가 오르면 가격도 단조 증가", () => {
    let prev = 0;
    for (let c = 1; c <= 100; c += 3) { const p = priceFor(usd(String(c))); expect(p).toBeGreaterThanOrEqual(prev); prev = p; }
  });
  it("원가 변동 허용 한도", () => {
    expect(driftAcceptable(usd("10.00"), usd("10.25"))).toBe(true);
    expect(driftAcceptable(usd("10.00"), usd("10.26"))).toBe(false);
    expect(driftAcceptable(usd("10.00"), usd("9.00"))).toBe(true);
  });
  it("갱신 상태: 수동 갱신 필요 시점 노출(API 갱신 미지원)", () => {
    const D = 86_400_000, now = 1_000_000 * D;
    expect(renewalState(now + 100 * D, now, false)).toBe("ok");
    expect(renewalState(now + 40 * D, now, false)).toBe("collect_payment");
    expect(renewalState(now + 10 * D, now, false)).toBe("expiring_soon");
    expect(renewalState(now + 10 * D, now, true)).toBe("operator_renewal_required");
    expect(renewalState(now + 40 * D, now, true)).toBe("ok");
    expect(renewalState(now - D, now, true)).toBe("expired");
  });
});

describe("Cloudflare Images 변환 경제성", () => {
  it("저장 절감 목적의 유료 변환은 회수 기간이 수년 → 하지 않음", () => {
    const months = imageRewritePaybackMonths(1_000_000, 0.5);
    expect(months).toBeGreaterThan(60);
    expect(decideImageRewrite({ sizeBytes: 1_000_000, expectedSavedRatio: 0.5, freeTransformsLeft: 0, accountPhysicalBytes: 100 * BYTES_PER_GB }).rewrite).toBe(false);
  });
  it("무료 저장 제공량 이내면 무료 변환이 남아도 손실 변환하지 않음", () => {
    expect(decideImageRewrite({ sizeBytes: 5_000_000, expectedSavedRatio: 0.6, freeTransformsLeft: 4000, accountPhysicalBytes: 3 * BYTES_PER_GB }).rewrite).toBe(false);
  });
  it("저장 요금 구간 + 무료 변환 예산이 있으면 허용, 매우 큰 파일은 유료여도 회수 가능", () => {
    expect(decideImageRewrite({ sizeBytes: 2_000_000, expectedSavedRatio: 0.5, freeTransformsLeft: 100, accountPhysicalBytes: 50 * BYTES_PER_GB }).rewrite).toBe(true);
    expect(decideImageRewrite({ sizeBytes: 90_000_000, expectedSavedRatio: 0.6, freeTransformsLeft: 0, accountPhysicalBytes: 50 * BYTES_PER_GB }).rewrite).toBe(true);
  });
  it("무료 변환 예산 공정 배분: 합계 ≤ 예산, 상한 준수, 남는 몫 재분배", () => {
    const r = allocateTransformBudget([{ bucketId: "a", requested: 5000 }, { bucketId: "b", requested: 100 }, { bucketId: "c", requested: 5000 }], 3000, 2000);
    const g = Object.fromEntries(r.map((x) => [x.bucketId, x.granted]));
    expect(g.b).toBe(100);
    expect(g.a! + g.b! + g.c!).toBe(3000);
    expect(g.a).toBe(1450); expect(g.c).toBe(1450);
    expect(Math.max(...r.map((x) => x.granted))).toBeLessThanOrEqual(2000);
    expect(allocateTransformBudget([{ bucketId: "a", requested: 10 }], 0, 100)[0]!.granted).toBe(0);
  });
  it("무작위 배분에서도 합계·수요 상한 불변식", () => {
    let seed = 5; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let k = 0; k < 100; k++) {
      const reqs = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => ({ bucketId: `b${i}`, requested: Math.floor(rnd() * 3000) }));
      const budget = Math.floor(rnd() * 5000), cap = 500 + Math.floor(rnd() * 2000);
      const out = allocateTransformBudget(reqs, budget, cap);
      expect(out.reduce((a, o) => a + o.granted, 0)).toBeLessThanOrEqual(budget);
      for (const o of out) expect(o.granted).toBeLessThanOrEqual(Math.min(reqs.find((r) => r.bucketId === o.bucketId)!.requested, cap));
      const need = reqs.reduce((a, r) => a + Math.min(r.requested, cap), 0);
      expect(out.reduce((a, o) => a + o.granted, 0)).toBe(Math.min(budget, need)); // 예산이 남으면 수요를 충족, 부족하면 전부 소진
    }
  });
});

describe("Cloudflare API 클라이언트·Registrar 요청 형태", () => {
  const ACC = "a".repeat(32);
  const mk = (responses: { status: number; body: unknown }[]) => {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: any }[] = [];
    const f: FetchLike = async (url, init) => { calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined }); const r = responses.shift()!; return { status: r.status, json: async () => r.body }; };
    return { calls, c: new CfClient({ token: "tok_secret", accountId: ACC, fetch: f }) };
  };
  it("토큰·계정 ID 검증, 베어러 인증, 오류 변환(재시도 가능 여부)", async () => {
    expect(() => new CfClient({ token: "", accountId: ACC })).toThrow();
    expect(() => new CfClient({ token: "t", accountId: "short" })).toThrow();
    const { c, calls } = mk([{ status: 200, body: { success: true, result: { ok: 1 } } }, { status: 429, body: { success: false, errors: [{ code: 971, message: "rate" }] } }, { status: 400, body: { success: false, errors: [{ code: 1061, message: "exists" }] } }]);
    await c.request("GET", "/zones");
    expect(calls[0]!.headers.Authorization).toBe("Bearer tok_secret");
    const e1 = (await c.request("GET", "/x").catch((e) => e)) as CfApiError;
    expect(e1.retryable).toBe(true);
    const e2 = (await c.request("GET", "/x").catch((e) => e)) as CfApiError;
    expect(e2.retryable).toBe(false);
    expect(e2.codes).toEqual([1061]);
    expect(e2.message).not.toContain("tok_secret");
  });
  it("Registrar: domain-check/등록 요청 경로·본문·Prefer 헤더, 가격 파싱", async () => {
    const { c, calls } = mk([
      { status: 200, body: { success: true, result: { domains: [{ name: "a.dev", registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "10.11", renewal_cost: "10.11" } }, { name: "b.uk", registrable: false, reason: "extension_not_supported_via_api" }] } } },
      { status: 202, body: { success: true, result: { domain_name: "a.dev", state: "in_progress", completed: false } } },
      { status: 200, body: { success: true, result: { domain_name: "a.dev", state: "succeeded", completed: true, context: { registration: { expires_at: "2027-10-18T00:00:00Z" } } } } },
    ]);
    const r = new CloudflareRegistrar(c);
    const chk = await r.check(["a.dev", "b.uk"]);
    expect(calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACC}/registrar/domain-check`);
    expect(calls[0]!.body).toEqual({ domains: ["a.dev", "b.uk"] });
    expect(chk[0]).toMatchObject({ registrable: true, registrationCostMicro: usd("10.11") });
    expect(chk[1]).toMatchObject({ registrable: false, reason: "extension_not_supported_via_api" });
    const contact = { email: "a@b.co", phone: "+82.1012345678", postal_info: { name: "A", address: { street: "s", city: "c", state: "s", postal_code: "1", country_code: "KR" } } };
    expect(await r.register("a.dev", contact)).toEqual({ outcome: "in_progress" });
    expect(calls[1]!.url).toContain("/registrar/registrations");
    expect(calls[1]!.headers.Prefer).toBe("respond-async");
    expect(calls[1]!.body).toEqual({ domain_name: "a.dev", contacts: { registrant: contact } });
    expect(await r.status("a.dev")).toEqual({ outcome: "succeeded", expiresAt: "2027-10-18T00:00:00Z" });
    expect(calls[2]!.url).toContain("/registrations/a.dev/registration-status");
    await expect(r.check([])).rejects.toThrow();
    await expect(r.check(Array.from({ length: 21 }, (_, i) => `d${i}.com`))).rejects.toThrow();
  });
});
