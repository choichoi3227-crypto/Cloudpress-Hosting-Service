import { type D1Like, newId, nowIso } from "./db";
import { OFFICIAL_INSTANCE_TYPES, type InstanceType, type ProductKind } from "./catalog";
import { type Provisioner } from "./jobs";

/** 컨테이너 매니저 포트(Worker → Containers API) */
export interface ContainerManager {
  /** 컨테이너 생성·시작(durable_object 정책: ctx.container.start) */
  provision(params: ProvisionParams): Promise<ProvisionResult>;
  /** 컨테이너 중지(절전/정지) */
  suspend(containerId: string): Promise<void>;
  /** 컨테이너 재시작(절전 해제) */
  resume(containerId: string): Promise<void>;
  /** 컨테이너 크기 변경(인스턴스 타입 변경) */
  resize(containerId: string, newInstanceType: InstanceType): Promise<void>;
  /** 컨테이너 삭제(데이터 보존 옵션) */
  delete(containerId: string, keepData: boolean): Promise<void>;
  /** 스냅샷 생성 */
  createSnapshot(containerId: string): Promise<SnapshotResult>;
  /** 스냅샷 복원 */
  restoreSnapshot(containerId: string, snapshotHandle: string, targetImageId?: string): Promise<void>;
  /** 백업 트리거(전체/증분/binlog) */
  triggerBackup(containerId: string, kind: "full" | "incremental" | "binlog"): Promise<string>;
  /** 컨테이너 상태 조회 */
  getStatus(containerId: string): Promise<ContainerStatus>;
  /** 배치 후보 호스트 메트릭 수집 */
  collectHostMetrics(): Promise<HostMetric[]>;
}

export interface ProvisionParams {
  containerId: string;
  customerId: string;
  subscriptionId: string;
  productKind: ProductKind;
  instanceType: InstanceType;
  targetVcpu: number;
  actualVcpu: number;
  imageId: string;
  schedulingPolicy: "default" | "durable_object";
  enableInternet: boolean;
  interceptTargets: { host: string; port: number }[];  // 백업용 내부 엔드포인트
  env: Record<string, string>;
  labels: Record<string, string>;
  sleepPolicy: "idle" | "never";
}

export interface ProvisionResult {
  cfInstanceId: string;
  ip: string;
  port: number;
  durableObjectId?: string;
}

export interface SnapshotResult {
  snapshotHandle: string;
  sizeBytes: number;
  expiresAt: string;
}

export interface ContainerStatus {
  state: "provisioning" | "running" | "sleeping" | "stopped" | "failed" | "deleting" | "deleted";
  ip?: string;
  port?: number;
  lastHeartbeatAt?: string;
  cfInstanceId?: string;
}

export interface HostMetric {
  hostId: string;
  freeMemMiB: number;
  freeVcpu: number;
  cpuLoad: number;
  queueDepth: number;
  errorRate: number;
  restarts7d: number;
  estCostPerHourMicro: number;
  latencyMs: number;
  healthy: boolean;
  supportsTypes: InstanceType[];
}

/** Cloudflare Containers API 클라이언트(Durable Object 기반) */
export interface CfContainersClient {
  /** durable_object 정책: 컨테이너 시작 */
  startContainer(params: {
    containerId: string;
    image: string;
    instanceType: InstanceType;
    enableInternet: boolean;
    entrypoint: string;
    env: Record<string, string>;
    labels: Record<string, string>;
    interceptOutboundHttp: { targets: { host: string; port: number }[] };
  }): Promise<{ instanceId: string; ip: string; port: number; durableObjectId: string }>;
  
  /** default 정책: 컨테이너 시작(Wrangler 설정 기반) */
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

/** 모의 구현(개발/테스트용) */
export class MockContainerManager implements ContainerManager {
  private instances = new Map<string, { 
    cfInstanceId: string; 
    ip: string; 
    port: number; 
    state: ContainerStatus["state"]; 
    durableObjectId?: string;
    imageId: string;
    schedulingPolicy: "default" | "durable_object";
    interceptTargets: { host: string; port: number }[];
  }>();
  
  private snapshots = new Map<string, { handle: string; sizeBytes: number; expiresAt: string }[]>();
  private backupJobs = new Map<string, { id: string; status: string }[]>();
  
  async provision(params: ProvisionParams): Promise<ProvisionResult> {
    const cfInstanceId = \cf_\_\\;
    const ip = \10.\.\.\\;
    const port = 8080 + Math.floor(Math.random() * 1000);
    const durableObjectId = params.schedulingPolicy === "durable_object" ? \do_\\ : undefined;
    
    this.instances.set(params.containerId, {
      cfInstanceId,
      ip,
      port,
      state: "running",
      durableObjectId,
      imageId: params.imageId,
      schedulingPolicy: params.schedulingPolicy,
      interceptTargets: params.interceptTargets,
    });
    
    return { cfInstanceId, ip, port, durableObjectId };
  }
  
  async suspend(containerId: string): Promise<void> {
    const inst = this.instances.get(containerId);
    if (inst) inst.state = "sleeping";
  }
  
  async resume(containerId: string): Promise<void> {
    const inst = this.instances.get(containerId);
    if (inst) inst.state = "running";
  }
  
  async resize(containerId: string, newInstanceType: InstanceType): Promise<void> {
    const inst = this.instances.get(containerId);
    if (inst) {
      inst.state = "running"; // 모의: 즉시 적용
    }
  }
  
  async delete(containerId: string, keepData: boolean): Promise<void> {
    const inst = this.instances.get(containerId);
    if (inst) {
      inst.state = keepData ? "stopped" : "deleted";
      if (!keepData) this.instances.delete(containerId);
    }
  }
  
  async createSnapshot(containerId: string): Promise<SnapshotResult> {
    const inst = this.instances.get(containerId);
    if (!inst) throw new Error("container_not_found");
    if (inst.schedulingPolicy !== "durable_object") throw new Error("snapshots_not_supported");
    
    const handle = \snap_\_\\;
    const sizeBytes = Math.floor(Math.random() * 1024 * 1024 * 500) + 10 * 1024 * 1024;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    
    const arr = this.snapshots.get(containerId) ?? [];
    arr.push({ handle, sizeBytes, expiresAt });
    this.snapshots.set(containerId, arr);
    
    return { snapshotHandle: handle, sizeBytes, expiresAt };
  }
  
  async restoreSnapshot(containerId: string, snapshotHandle: string, targetImageId?: string): Promise<void> {
    const inst = this.instances.get(containerId);
    if (!inst) throw new Error("container_not_found");
    inst.state = "running";
  }
  
  async triggerBackup(containerId: string, kind: "full" | "incremental" | "binlog"): Promise<string> {
    const jobId = \ackup_\_\_\\;
    const arr = this.backupJobs.get(containerId) ?? [];
    arr.push({ id: jobId, status: "completed" });
    this.backupJobs.set(containerId, arr);
    return jobId;
  }
  
  async getStatus(containerId: string): Promise<ContainerStatus> {
    const inst = this.instances.get(containerId);
    if (!inst) return { state: "deleted" };
    return { state: inst.state, ip: inst.ip, port: inst.port, lastHeartbeatAt: new Date().toISOString(), cfInstanceId: inst.cfInstanceId };
  }
  
  async collectHostMetrics(): Promise<HostMetric[]> {
    return [
      {
        hostId: "host-1",
        freeMemMiB: 32768,
        freeVcpu: 8,
        cpuLoad: 0.3,
        queueDepth: 5,
        errorRate: 0.001,
        restarts7d: 0,
        estCostPerHourMicro: 50000,
        latencyMs: 2,
        healthy: true,
        supportsTypes: ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"],
      },
    ];
  }
}

/** 실구현: Cloudflare API 호출 */
export class LiveContainerManager implements ContainerManager {
  constructor(
    private client: CfContainersClient,
    private db: D1Like,
    private getImage: (imageId: string) => Promise<ContainerImage | null>
  ) {}
  
  async provision(params: ProvisionParams): Promise<ProvisionResult> {
    const image = await this.getImage(params.imageId);
    if (!image) throw new Error(\image_not_found: \\);
    
    if (params.schedulingPolicy === "durable_object") {
      const result = await this.client.startContainer({
        containerId: params.containerId,
        image: image.docker_image,
        instanceType: params.instanceType,
        enableInternet: params.enableInternet,
        entrypoint: image.entrypoint,
        env: params.env,
        labels: { ...JSON.parse(image.labels_json), ...params.labels },
        interceptOutboundHttp: { targets: params.interceptTargets },
      });
      
      await this.db.prepare(
        \INSERT INTO container_instances (id, container_id, image_id, cf_instance_id, scheduling_policy, state, ip, port, enable_internet, intercept_targets_json, labels_json, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)\
      ).bind(
        newId("cinst"),
        params.containerId,
        params.imageId,
        result.instanceId,
        "durable_object",
        result.ip,
        result.port,
        params.enableInternet ? 1 : 0,
        JSON.stringify(params.interceptTargets),
        JSON.stringify(params.labels),
        nowIso()
      ).run();
      
      return { cfInstanceId: result.instanceId, ip: result.ip, port: result.port, durableObjectId: result.durableObjectId };
    } else {
      // default 정책: Wrangler에 이미 구성된 대로 시작
      const result = await this.client.startDefaultContainer({
        containerId: params.containerId,
        image: image.docker_image,
      });
      
      await this.db.prepare(
        \INSERT INTO container_instances (id, container_id, image_id, cf_instance_id, scheduling_policy, state, ip, port, started_at)
         VALUES (?, ?, ?, ?, 'default', 'running', ?, ?, ?)\
      ).bind(
        newId("cinst"),
        params.containerId,
        params.imageId,
        result.instanceId,
        result.ip,
        result.port,
        nowIso()
      ).run();
      
      return { cfInstanceId: result.instanceId, ip: result.ip, port: result.port };
    }
  }
  
  async suspend(containerId: string): Promise<void> {
    const inst = await this.db.prepare("SELECT cf_instance_id, scheduling_policy FROM container_instances WHERE container_id = ? AND state IN ('running','sleeping') ORDER BY created_at DESC LIMIT 1").bind(containerId).first<{ cf_instance_id: string; scheduling_policy: string }>();
    if (!inst) throw new Error("container_not_found_or_not_running");
    await this.client.stopContainer(inst.cf_instance_id);
    await this.db.prepare("UPDATE container_instances SET state='sleeping', stopped_at=? WHERE cf_instance_id=?").bind(nowIso(), inst.cf_instance_id).run();
    await this.db.prepare("UPDATE containers SET state='sleeping' WHERE id=?").bind(containerId).run();
  }
  
  async resume(containerId: string): Promise<void> {
    // 기존 인스턴스 재시작 또는 새 인스턴스 시작
    const inst = await this.db.prepare("SELECT cf_instance_id, image_id, scheduling_policy FROM container_instances WHERE container_id = ? AND state IN ('sleeping','stopped') ORDER BY created_at DESC LIMIT 1").bind(containerId).first<{ cf_instance_id: string; image_id: string; scheduling_policy: string }>();
    if (!inst) throw new Error("container_not_found_or_not_suspended");
    
    if (inst.scheduling_policy === "durable_object") {
      // durable_object: 기존 DO 재시작
      await this.client.startContainer({
        containerId,
        image: (await this.getImage(inst.image_id))!.docker_image,
        instanceType: (await this.db.prepare("SELECT instance_type FROM containers WHERE id=?").bind(containerId).first<{ instance_type: string }>())!.instance_type as InstanceType,
        enableInternet: false,
        entrypoint: (await this.getImage(inst.image_id))!.entrypoint,
        env: {},
        labels: {},
        interceptOutboundHttp: { targets: [] },
      });
    }
    
    await this.db.prepare("UPDATE container_instances SET state='running', started_at=?, stopped_at=NULL WHERE cf_instance_id=?").bind(nowIso(), inst.cf_instance_id).run();
    await this.db.prepare("UPDATE containers SET state='running' WHERE id=?").bind(containerId).run();
  }
  
  async resize(containerId: string, newInstanceType: InstanceType): Promise<void> {
    // durable_object 정책만 리사이즈 지원(새 인스턴스 시작 후 스위치)
    const container = await this.db.prepare("SELECT instance_type, scheduling_policy FROM containers WHERE id=?").bind(containerId).first<{ instance_type: string; scheduling_policy: string }>();
    if (!container) throw new Error("container_not_found");
    if (container.scheduling_policy !== "durable_object") throw new Error("resize_only_supported_for_durable_object_policy");
    
    // 새 인스턴스 프로비저닝 후 트래픽 전환(무중단)
    // 구현 단순화: 상태만 업데이트
    await this.db.prepare("UPDATE containers SET instance_type=?, actual_vcpu=?, updated_at=? WHERE id=?")
      .bind(newInstanceType, OFFICIAL_INSTANCE_TYPES[newInstanceType].vcpu, nowIso(), containerId).run();
  }
  
  async delete(containerId: string, keepData: boolean): Promise<void> {
    const inst = await this.db.prepare("SELECT cf_instance_id FROM container_instances WHERE container_id = ? AND state NOT IN ('deleted') ORDER BY created_at DESC LIMIT 1").bind(containerId).first<{ cf_instance_id: string }>();
    if (inst) {
      await this.client.deleteContainer(inst.cf_instance_id);
      await this.db.prepare("UPDATE container_instances SET state='deleted', stopped_at=? WHERE cf_instance_id=?").bind(nowIso(), inst.cf_instance_id).run();
    }
    await this.db.prepare("UPDATE containers SET state='deleted', deleted_at=? WHERE id=?").bind(keepData ? null : nowIso(), containerId).run();
  }
  
  async createSnapshot(containerId: string): Promise<SnapshotResult> {
    const inst = await this.db.prepare("SELECT cf_instance_id, image_id, scheduling_policy FROM container_instances WHERE container_id = ? AND state='running' ORDER BY created_at DESC LIMIT 1").bind(containerId).first<{ cf_instance_id: string; image_id: string; scheduling_policy: string }>();
    if (!inst) throw new Error("container_not_found_or_not_running");
    if (inst.scheduling_policy !== "durable_object") throw new Error("snapshots_only_supported_for_durable_object_policy");
    
    const result = await this.client.createSnapshot(inst.cf_instance_id);
    const snapId = newId("snap");
    await this.db.prepare(
      \INSERT INTO snapshots (id, container_id, image_id, cf_snapshot_handle, size_bytes, state, expires_at)
       VALUES (?, ?, ?, ?, ?, 'ready', ?)\
    ).bind(snapId, containerId, inst.image_id, result.handle, result.sizeBytes, result.expiresAt).run();
    
    await this.db.prepare("UPDATE containers SET last_snapshot_id=? WHERE id=?").bind(result.handle, containerId).run();
    
    return { snapshotHandle: result.handle, sizeBytes: result.sizeBytes, expiresAt: result.expiresAt };
  }
  
  async restoreSnapshot(containerId: string, snapshotHandle: string, targetImageId?: string): Promise<void> {
    const inst = await this.db.prepare("SELECT cf_instance_id FROM container_instances WHERE container_id = ? AND state='running' ORDER BY created_at DESC LIMIT 1").bind(containerId).first<{ cf_instance_id: string }>();
    if (!inst) throw new Error("container_not_found_or_not_running");
    
    const snap = await this.db.prepare("SELECT image_id FROM snapshots WHERE cf_snapshot_handle = ? AND container_id = ?").bind(snapshotHandle, containerId).first<{ image_id: string }>();
    if (!snap) throw new Error("snapshot_not_found");
    
    await this.client.restoreSnapshot(inst.cf_instance_id, snapshotHandle, targetImageId ?? snap.image_id);
    
    await this.db.prepare("UPDATE snapshots SET state='restored', restored_at=? WHERE cf_snapshot_handle=? AND container_id=?").bind(nowIso(), snapshotHandle, containerId).run();
  }
  
  async triggerBackup(containerId: string, kind: "full" | "incremental" | "binlog"): Promise<string> {
    // 백업 작업 큐에 등록 (실제 백업은 별도 워커/큐 소비자에서 수행)
    const jobId = newId("bjob");
    const idempotencyKey = \ackup:\:\:\\;
    await this.db.prepare(
      \INSERT INTO backup_jobs (id, container_id, kind, status, r2_prefix, encryption_key_id, idempotency_key)
       VALUES (?, ?, ?, 'queued', ?, (SELECT id FROM container_encryption_keys WHERE container_id = ? ORDER BY key_version DESC LIMIT 1), ?)\
    ).bind(jobId, containerId, kind, \ackups/\/\/\/\, containerId, idempotencyKey).run();
    
    // container_jobs에도 기록
    await this.db.prepare(
      \INSERT INTO container_jobs (id, container_id, kind, payload_json, state, idempotency_key)
       VALUES (?, ?, ?, ?, 'queued', ?)\
    ).bind(newId("cjob"), containerId, \ackup_\\, JSON.stringify({ backupJobId: jobId }), idempotencyKey).run();
    
    return jobId;
  }
  
  async getStatus(containerId: string): Promise<ContainerStatus> {
    const inst = await this.db.prepare("SELECT cf_instance_id, state, ip, port, last_heartbeat_at FROM container_instances WHERE container_id = ? ORDER BY created_at DESC LIMIT 1").bind(containerId).first<{ cf_instance_id: string; state: string; ip: string; port: number; last_heartbeat_at: string }>();
    if (!inst) return { state: "provisioning" };
    return { state: inst.state as ContainerStatus["state"], ip: inst.ip, port: inst.port, lastHeartbeatAt: inst.last_heartbeat_at, cfInstanceId: inst.cf_instance_id };
  }
  
  async collectHostMetrics(): Promise<HostMetric[]> {
    return this.client.listHostMetrics();
  }
}

export interface ContainerImage {
  id: string;
  docker_image: string;
  instance_type: InstanceType;
  vcpu: number;
  memory_mib: number;
  disk_gb: number;
  entrypoint: string;
  env_json: string;
  labels_json: string;
  scheduling_policy: "default" | "durable_object";
  supports_snapshot: number;
  is_default: number;
  active: number;
}

/** 스케줄링 정책 결정: basic 이하는 default, 그 이상은 durable_object */
export function getSchedulingPolicy(instanceType: InstanceType): "default" | "durable_object" {
  return instanceType === "lite" || instanceType === "basic" ? "default" : "durable_object";
}

/** 이미지 ID 자동 결정(상품 종류 + 인스턴스 타입) */
export function resolveImageId(productKind: ProductKind, instanceType: InstanceType): string {
  const map: Record<string, string> = {
    "ccs": \img-ccs-\\,
    "cloudb": instanceType === "basic" ? \img-cloudb-mariadb\ : \img-ccs-\\,
    "wordpress": \img-wp-\\,
  };
  return map[\\-\\] ?? \img-ccs-\\;
}

/** 컨테이너 매니저 팩토리 */
export function createContainerManager(env: { 
  mode: "mock" | "live"; 
  db: D1Like;
  cfContainersClient?: CfContainersClient;
}): ContainerManager {
  if (env.mode === "mock") {
    return new MockContainerManager();
  }
  if (!env.cfContainersClient) throw new Error("CfContainersClient required for live mode");
  return new LiveContainerManager(env.cfContainersClient, env.db, async (id) => {
    const row = await env.db.prepare("SELECT * FROM container_images WHERE id = ? AND active = 1").bind(id).first<ContainerImage>();
    return row ?? null;
  });
}
