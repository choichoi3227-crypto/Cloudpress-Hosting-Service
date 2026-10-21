// Cloudflare Containers API 클라이언트 (Durable Object와 상호작용)
// 실제 Cloudflare Containers API는 Worker의 Durable Object를 통해 제어된다.
// 따라서 이 클라이언트는 Durable Object 스텁 또는 실제 Durable Object API를 호출하는 역할을 한다.

import { type InstanceType } from "./catalog";
import type { ContainerStatus, HostMetric } from "./containerManager";

export interface CfContainersClient {
  // Durable Object 정책 컨테이너 시작
  startContainer(params: {
    containerId: string; // 컨테이너 논리 ID
    image: string; // Docker 이미지 이름
    instanceType: InstanceType;
    enableInternet: boolean;
    entrypoint: string;
    env: Record<string, string>;
    labels: Record<string, string>;
    interceptOutboundHttp: { targets: { host: string; port: number }[] };
  }): Promise<{ instanceId: string; ip: string; port: number; durableObjectId: string }>;

  // Default 정책 컨테이너 시작 (Wrangler 설정 기반)
  startDefaultContainer(params: {
    containerId: string;
    image: string;
  }): Promise<{ instanceId: string; ip: string; port: number }>;

  stopContainer(instanceId: string): Promise<void>;
  deleteContainer(instanceId: string): Promise<void>;
  createSnapshot(instanceId: string): Promise<{ handle: string; sizeBytes: number; expiresAt: string }>;
  restoreSnapshot(instanceId: string, snapshotHandle: string, targetImage?: string): Promise<void>;
  getContainerStatus(instanceId: string): Promise<ContainerStatus>;
  listHostMetrics(): Promise<HostMetric[]>;
}

// Mock 구현
export class MockCfContainersClient implements CfContainersClient {
  private instances = new Map<string, { 
    instanceId: string;
    ip: string;
    port: number;
    state: ContainerStatus["state"];
    durableObjectId?: string;
  }>();
  private snapshots = new Map<string, { handle: string; sizeBytes: number; expiresAt: string }[]>();

  async startContainer(params: any): Promise<{ instanceId: string; ip: string; port: number; durableObjectId: string }> {
    const instanceId = `cfi_do_${params.containerId}_${Date.now()}`;
    const ip = `10.0.0.${Math.floor(Math.random() * 255)}`;
    const port = 8080;
    const durableObjectId = `do_${params.containerId}`;
    this.instances.set(params.containerId, { instanceId, ip, port, state: "running", durableObjectId });
    console.log(`Mock DO container started: ${params.containerId}`);
    return { instanceId, ip, port, durableObjectId };
  }

  async startDefaultContainer(params: any): Promise<{ instanceId: string; ip: string; port: number }> {
    const instanceId = `cfi_default_${params.containerId}_${Date.now()}`;
    const ip = `10.1.0.${Math.floor(Math.random() * 255)}`;
    const port = 8080;
    this.instances.set(params.containerId, { instanceId, ip, port, state: "running" });
    console.log(`Mock Default container started: ${params.containerId}`);
    return { instanceId, ip, port };
  }

  async stopContainer(instanceId: string): Promise<void> {
    for (const [key, value] of this.instances.entries()) {
      if (value.instanceId === instanceId) {
        value.state = "stopped";
        console.log(`Mock container stopped: ${key}`);
        return;
      }
    }
    throw new Error("Mock instance not found");
  }

  async deleteContainer(instanceId: string): Promise<void> {
    let found = false;
    for (const [key, value] of this.instances.entries()) {
      if (value.instanceId === instanceId) {
        this.instances.delete(key);
        found = true;
        console.log(`Mock container deleted: ${key}`);
        break;
      }
    }
    if (!found) throw new Error("Mock instance not found");
  }

  async createSnapshot(instanceId: string): Promise<{ handle: string; sizeBytes: number; expiresAt: string }> {
    const handle = `snap_${instanceId}_${Date.now()}`;
    const sizeBytes = Math.floor(Math.random() * 1024 * 1024 * 500) + 10 * 1024 * 1024; // 10MB - 510MB
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const snaps = this.snapshots.get(instanceId) || [];
    snaps.push({ handle, sizeBytes, expiresAt });
    this.snapshots.set(instanceId, snaps);
    console.log(`Mock snapshot created for ${instanceId}: ${handle}`);
    return { handle, sizeBytes, expiresAt };
  }

  async restoreSnapshot(instanceId: string, snapshotHandle: string, targetImage?: string): Promise<void> {
    console.log(`Mock restore snapshot ${snapshotHandle} to ${instanceId}`);
  }

  async getContainerStatus(instanceId: string): Promise<ContainerStatus> {
    for (const [key, value] of this.instances.entries()) {
      if (value.instanceId === instanceId) {
        return { state: value.state, ip: value.ip, port: value.port, cfInstanceId: value.instanceId, lastHeartbeatAt: new Date().toISOString() };
      }
    }
    return { state: "deleted" };
  }

  async listHostMetrics(): Promise<HostMetric[]> {
    return [
      { hostId: "host-alpha", freeMemMiB: 16384, freeVcpu: 2, cpuLoad: 0.1, queueDepth: 2, errorRate: 0.001, restarts7d: 0, estCostPerHourMicro: 10000, latencyMs: 10, healthy: true, supportsTypes: ["lite", "basic", "standard-1"] },
      { hostId: "host-beta", freeMemMiB: 32768, freeVcpu: 4, cpuLoad: 0.2, queueDepth: 5, errorRate: 0.005, restarts7d: 1, estCostPerHourMicro: 20000, latencyMs: 20, healthy: true, supportsTypes: ["standard-2", "standard-3", "standard-4"] },
    ];
  }
}
