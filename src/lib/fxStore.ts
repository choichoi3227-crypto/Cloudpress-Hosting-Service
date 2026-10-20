import { type D1Like, nowIso } from "./db";
import { ingestSample, SEED_FX_CONFIG, type FxSample, type FxState, type FxConfig } from "./fx";

/** DB 의 수용된 최근 표본과 보류 표본으로 상태를 복원한다. */
export async function loadFxState(db: D1Like, cfg: FxConfig = SEED_FX_CONFIG): Promise<FxState> {
  const acc = await db.prepare("SELECT rate_micro AS r, source AS s, fetched_at AS t FROM fx_rates WHERE pair='USD/KRW' AND status='accepted' ORDER BY fetched_at DESC, id DESC LIMIT ?").bind(cfg.window).all<{ r: number; s: string; t: string }>();
  const lastAccepted = acc.results[0]?.t ?? "";
  const pend = await db.prepare("SELECT rate_micro AS r, source AS s, fetched_at AS t FROM fx_rates WHERE pair='USD/KRW' AND status='quarantined' AND fetched_at > ? ORDER BY fetched_at DESC, id DESC LIMIT 1").bind(lastAccepted).first<{ r: number; s: string; t: string }>();
  const toS = (x: { r: number; s: string; t: string }): FxSample => ({ rateMicro: x.r, source: x.s, fetchedAtMs: Date.parse(x.t) });
  return { accepted: acc.results.map(toS).reverse(), pending: pend ? toS(pend) : undefined };
}

/** 표본 1건을 수용 규칙에 따라 처리하고 결과(수용·거부·보류)를 모두 기록한다. */
export async function recordFxSample(db: D1Like, sample: FxSample, nowMs: number, cfg: FxConfig = SEED_FX_CONFIG) {
  const res = ingestSample(await loadFxState(db, cfg), sample, nowMs, cfg);
  await db.prepare("INSERT INTO fx_rates(pair,rate_micro,source,fetched_at,status,reason) VALUES('USD/KRW',?,?,?,?,?)").bind(Math.max(1, Math.trunc(sample.rateMicro) || 1), sample.source, nowIso(sample.fetchedAtMs), res.status, res.reason).run();
  return res;
}
