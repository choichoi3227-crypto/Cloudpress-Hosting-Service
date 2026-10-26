import type { Env } from "./worker";
import { PayPalHttp, MockPayPal, type PayPalPort } from "./lib/paypal.client";
import { CfClient } from "./lib/cfApi";
import { CloudflareRegistrar, MockRegistrar, type RegistrarPort, type NameserverPort } from "./lib/registrar";
import { GabiaRegistrar, MockGabiaClient, type PortMap } from "./lib/registrarRouter";
import { CloudflareZones, MockZones, type ZonesPort } from "./lib/zones";
import { encryptSecret, decryptSecret } from "./lib/crypto";
import type { Crypto } from "./lib/domainOrders";
import type { Provisioner } from "./lib/jobs";

export class ConfigError extends Error {}

export interface Runtime {
  mode: "mock" | "live";
  paypal: PayPalPort;
  /** PayPal 환경(sandbox|live). 고객 자동결제 관리 링크 등에 쓴다. */
  paypalEnv: "sandbox" | "live";
  ports: PortMap;
  portFor(provider: string): RegistrarPort;
  nsPortFor(provider: string): NameserverPort;
  zones: ZonesPort;
  crypto: Crypto;
  provisioner: Provisioner | null;
}

/** 개발용 고정 키. mock 모드에서만 사용하며 운영에서는 절대 쓰지 않는다(운영은 SECRETS_ENCRYPTION_KEY 필수). */
const DEV_ONLY_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
let mock: Runtime | null = null;

/**
 * mock: 외부 연결 없이 메모리 구현으로 동작(실제 비용·결제 없음).
 * live: 필요한 비밀 값이 모두 있어야 하며, 하나라도 없으면 명확한 오류로 거부한다(연결되지 않은 기능을 작동하는 것처럼 보이지 않음).
 */
export function buildRuntime(env: Env): Runtime {
  if (env.CLOUDPRESS_MODE !== "live") {
    if (!mock) {
      const cf = new MockRegistrar(); const gc = new MockGabiaClient(); const gabia = new GabiaRegistrar(gc);
      const crypto: Crypto = { encrypt: (p, a) => encryptSecret(p, DEV_ONLY_KEY, a), decrypt: (t, a) => decryptSecret(t, DEV_ONLY_KEY, a) };
      mock = { mode: "mock", paypal: new MockPayPal(), paypalEnv: "sandbox", ports: { cloudflare: cf, gabia }, portFor: (p) => (p === "gabia" ? gabia : cf), nsPortFor: () => gabia, zones: new MockZones(), crypto, provisioner: { provision: async () => {}, suspend: async () => {}, resume: async () => {} } };
    }
    return mock;
  }
  const missing = (["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "SECRETS_ENCRYPTION_KEY"] as const).filter((k) => !env[k]);
  if (missing.length) throw new ConfigError(`live 모드에 필요한 비밀 값이 없음: ${missing.join(", ")}`);
  const cf = new CfClient({ token: env.CLOUDFLARE_API_TOKEN!, accountId: env.CLOUDFLARE_ACCOUNT_ID! });
  const registrar = new CloudflareRegistrar(cf);
  const gabia = new GabiaRegistrar(null); // 가비아 파트너 계약·API 명세 전에는 연결하지 않음(호출 시 ProviderNotConfigured)
  const key = env.SECRETS_ENCRYPTION_KEY!;
  return {
    mode: "live",
    paypal: new PayPalHttp({ clientId: env.PAYPAL_CLIENT_ID!, clientSecret: env.PAYPAL_CLIENT_SECRET!, env: env.PAYPAL_ENV === "sandbox" ? "sandbox" : "live" }),
    paypalEnv: env.PAYPAL_ENV === "sandbox" ? "sandbox" : "live",
    ports: { cloudflare: registrar }, // 가비아는 설정 후에만 라우팅 대상에 포함
    portFor: (p) => (p === "gabia" ? gabia : registrar),
    nsPortFor: (p) => (p === "gabia" ? gabia : { setNameservers: async () => {} }),
    zones: new CloudflareZones(cf),
    crypto: { encrypt: (p, a) => encryptSecret(p, key, a), decrypt: (t, a) => decryptSecret(t, key, a) },
    provisioner: null, // 컨테이너 매니저 구현 전: 프로비저닝 작업은 폐기·운영자 알림으로 드러난다
  };
}
