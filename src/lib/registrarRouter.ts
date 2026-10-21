import type { RegistrarPort, NameserverPort, RegistrarError } from "./registrar";

export interface PortMap { cloudflare: RegistrarPort; gabia: RegistrarPort }

/** 가비아 파트너 API 클라이언트 */
export class GabiaRegistrar implements RegistrarPort, NameserverPort {
  constructor(private token: string | null) {}

  async checkDomain(hostname: string): Promise<{ available: boolean; price: number }> {
    if (!this.token) throw new Error("partner_not_configured");
    // 가비아 API 호출 (OAuth Token 사용)
    // 실제 엔드포인트 연동 로직
    return { available: true, price: 12000 }; 
  }

  async registerDomain(hostname: string, contact: any): Promise<void> {
    if (!this.token) throw new Error("partner_not_configured");
    // 도메인 등록 POST 호출
  }

  async setNameservers(hostname: string, nss: string[]): Promise<void> {
    if (!this.token) throw new Error("partner_not_configured");
    // 네임서버 변경 API 호출
  }
}
