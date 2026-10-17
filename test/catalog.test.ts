import { describe, it, expect } from "vitest";
import { SEED_PRODUCTS, validateCatalog, OFFICIAL_INSTANCE_TYPES, getProduct } from "../src/lib/catalog";

describe("catalog", () => {
  it("시드 카탈로그는 공식 사양과 모순 없음", () => {
    expect(validateCatalog(SEED_PRODUCTS)).toEqual([]);
  });
  it("CPU 목표가 실제 할당보다 크면 거부(가짜 사양 판매 방지)", () => {
    const bad = [{ ...getProduct("ccs-basic"), id: "x", targetVcpu: 2 }];
    expect(validateCatalog(bad)[0]?.message).toContain("CPU 목표");
  });
  it("미지원 타입 거부", () => {
    const bad = [{ ...getProduct("ccs-basic"), id: "y", instanceType: "standard-9" as never }];
    expect(validateCatalog(bad).length).toBeGreaterThan(0);
  });
  it("2 vCPU 실제 할당 상품은 standard-3 뿐", () => {
    const two = SEED_PRODUCTS.filter((p) => p.instanceType && OFFICIAL_INSTANCE_TYPES[p.instanceType].vcpu >= 2).map((p) => p.id);
    expect(two.sort()).toEqual(["ccs-performance", "wp-scale"]);
  });
  it("WordPress는 하위 서비스를 포함", () => {
    for (const id of ["wp-starter", "wp-pro", "wp-business", "wp-scale"]) {
      expect(getProduct(id).includes).toEqual(["ccs", "cloudb", "cloudage", "csw"]);
    }
  });
});
