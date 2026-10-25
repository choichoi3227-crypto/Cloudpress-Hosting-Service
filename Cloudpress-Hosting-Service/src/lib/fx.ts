/** 환율(원/USD)은 정수 micro 단위(×1,000,000)로 다룬다. 외부 환율 원천은 포트로 주입한다. */
export interface FxSample { rateMicro: number; fetchedAtMs: number; source: string }
export interface FxConfig { maxAgeMs: number; maxJumpBp: number; window: number; confirmToleranceBp: number; bufferBp: number }
export const SEED_FX_CONFIG: FxConfig = { maxAgeMs: 6 * 3_600_000, maxJumpBp: 300, window: 12, confirmToleranceBp: 50, bufferBp: 150 };

export interface FxState { accepted: FxSample[]; pending?: FxSample }
export interface IngestResult { state: FxState; status: "accepted" | "rejected" | "quarantined"; reason: string }
export interface FxRateProvider { fetchUsdKrw(): Promise<FxSample> }

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2); };
export const smoothedRate = (s: FxState): number | null => (s.accepted.length ? median(s.accepted.map((x) => x.rateMicro)) : null);

/**
 * 환율 표본 수용 규칙(이상치가 가격에 반영되지 않게):
 * - 0 이하·비정수·오래된 표본은 거부
 * - 평활값(최근 N개 중앙값) 대비 maxJumpBp 를 넘는 급변은 보류하고, 다른 시각·원천의 두 번째 표본이 근접 확인할 때만 수용
 */
export function ingestSample(state: FxState, s: FxSample, nowMs: number, cfg: FxConfig = SEED_FX_CONFIG): IngestResult {
  if (!Number.isInteger(s.rateMicro) || s.rateMicro <= 0) return { state, status: "rejected", reason: "잘못된 환율 값" };
  if (nowMs - s.fetchedAtMs > cfg.maxAgeMs) return { state, status: "rejected", reason: "오래된 표본" };
  const base = smoothedRate(state);
  const accept = (st: FxState, reason: string): IngestResult => ({ state: { accepted: [...st.accepted, s].slice(-cfg.window), pending: undefined }, status: "accepted", reason });
  if (base === null) return accept(state, "최초 표본");
  const jumpBp = (Math.abs(s.rateMicro - base) * 10_000) / base;
  if (jumpBp <= cfg.maxJumpBp) return accept(state, "정상 범위");
  const p = state.pending;
  if (p && (p.source !== s.source || p.fetchedAtMs !== s.fetchedAtMs) && (Math.abs(p.rateMicro - s.rateMicro) * 10_000) / p.rateMicro <= cfg.confirmToleranceBp) return accept(state, "급변을 독립 표본이 확인");
  return { state: { ...state, pending: s }, status: "quarantined", reason: `평활값 대비 ${Math.round(jumpBp)}bp 급변: 확인 전까지 보류` };
}

export interface CurrentRate { rateMicro: number; stale: boolean }
export function currentRate(state: FxState, nowMs: number, cfg: FxConfig = SEED_FX_CONFIG): CurrentRate | null {
  const r = smoothedRate(state);
  if (r === null) return null;
  const last = state.accepted[state.accepted.length - 1]!;
  return { rateMicro: r, stale: nowMs - last.fetchedAtMs > cfg.maxAgeMs };
}

/** USD 원가를 KRW 로 환산할 때는 원화 약세(USD 상승) 위험을 감안해 버퍼를 얹은 환율을 쓴다. */
export const costSideRate = (rateMicro: number, cfg: FxConfig = SEED_FX_CONFIG) => Math.ceil((rateMicro * (10_000 + cfg.bufferBp)) / 10_000);

/** micro-USD → 원(올림). rateMicro = 원/USD × 1e6. */
export const usdMicroToWon = (usdMicro: number, rateMicro: number) => Math.ceil((usdMicro * rateMicro) / 1e12);
/** 원 → micro-USD(내림). */
export const wonToUsdMicro = (won: number, rateMicro: number) => Math.floor((won * 1e12) / rateMicro);
