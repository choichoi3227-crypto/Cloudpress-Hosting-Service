/** 도메인 이름 정규화·검증. IDN 은 punycode 로 변환(WHATWG URL 사용). */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** 여러 라벨로 이루어진 공개 접미사(소규모 내장 목록). 정확한 판정은 Cloudflare 가 하며 거부 시 오류를 그대로 전달한다. */
const MULTI_LABEL_SUFFIXES = new Set(["co.kr", "or.kr", "ne.kr", "go.kr", "re.kr", "pe.kr", "ac.kr", "mil.kr", "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au", "co.jp", "or.jp", "ne.jp", "com.br", "co.nz", "co.in", "com.cn", "com.tw", "com.sg", "com.hk"]);

export function normalizeHostname(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!s || s.length > 253 || /[\s/@:?#\\]/.test(s)) return null;
  let host: string;
  try { host = new URL(`http://${s}`).hostname; } catch { return null; }
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => !LABEL.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null; // IP 주소 형태 금지
  return host;
}

/** 등록 가능한(apex) 도메인인지: 공개 접미사 바로 위 한 라벨. 서브도메인은 전체 영역(full zone)으로 만들 수 없다. */
export function isApexDomain(host: string): boolean {
  const labels = host.split(".");
  const suffixLabels = labels.length >= 3 && MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 2 : 1;
  return labels.length === suffixLabels + 1;
}

export const tldOf = (host: string) => host.split(".").slice(-1)[0]!;
