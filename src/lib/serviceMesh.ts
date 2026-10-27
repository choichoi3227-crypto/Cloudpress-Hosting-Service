import { type D1Like, newId, nowIso } from "./db";

export interface ServiceEndpoint {
  id: string;
  serviceName: string;
  namespace: string;
  containerId: string;
  ip: string;
  port: number;
  protocol: "http" | "https" | "tcp" | "grpc";
  healthCheckPath?: string;
  metadata: Record<string, string>;
  registeredAt: string;
  lastHeartbeatAt: string;
  healthy: boolean;
}

export interface ServiceRegistration {
  serviceName: string;
  namespace: string;
  containerId: string;
  port: number;
  protocol: "http" | "https" | "tcp" | "grpc";
  healthCheckPath?: string;
  metadata?: Record<string, string>;
}

export interface TrafficPolicy {
  id: string;
  sourceService: string;
  targetService: string;
  namespace: string;
  policy: "allow" | "deny" | "rate_limit" | "retry" | "timeout" | "circuit_breaker";
  config: Record<string, unknown>;
  priority: number;
  createdAt: string;
}

export interface MTLSConfig {
  enabled: boolean;
  caCert: string;
  certRotationHours: number;
  allowedSans: string[];
}

export class ServiceMeshManager {
  constructor(
    private db: D1Like,
    private cfContainersClient: any,
    private mtlsConfig: MTLSConfig = { enabled: true, caCert: "", certRotationHours: 24, allowedSans: [] }
  ) {}

  async registerService(params: ServiceRegistration): Promise<ServiceEndpoint> {
    const now = nowIso();
    const endpointId = newId("sep");
    
    const containerStatus = await this.cfContainersClient.getContainerStatus(params.containerId);
    
    const endpoint: ServiceEndpoint = {
      id: endpointId,
      serviceName: params.serviceName,
      namespace: params.namespace,
      containerId: params.containerId,
      ip: containerStatus.ip || "127.0.0.1",
      port: params.port,
      protocol: params.protocol,
      healthCheckPath: params.healthCheckPath,
      metadata: params.metadata || {},
      registeredAt: now,
      lastHeartbeatAt: now,
      healthy: true,
    };

    await this.db.prepare("INSERT INTO service_endpoints (id, service_name, namespace, container_id, ip, port, protocol, health_check_path, metadata_json, registered_at, last_heartbeat_at, healthy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
      endpointId,
      params.serviceName,
      params.namespace,
      params.containerId,
      endpoint.ip,
      params.port,
      params.protocol,
      params.healthCheckPath || null,
      JSON.stringify(endpoint.metadata),
      now,
      now,
      1
    ).run();

    if (this.mtlsConfig.enabled) {
      await this.issueServiceCertificate(endpoint);
    }

    return endpoint;
  }

  async deregisterService(containerId: string): Promise<void> {
    await this.db.prepare("UPDATE service_endpoints SET healthy = 0, deregistered_at = ? WHERE container_id = ?").bind(nowIso(), containerId).run();
    await this.revokeServiceCertificate(containerId);
  }

  async discoverServices(serviceName: string, namespace: string = "default"): Promise<ServiceEndpoint[]> {
    const rows = await this.db.prepare("SELECT * FROM service_endpoints WHERE service_name = ? AND namespace = ? AND healthy = 1 AND datetime(last_heartbeat_at) > datetime('now', '-30 seconds')").bind(serviceName, namespace).all();

    return rows.results.map(this.mapRowToEndpoint);
  }

  async listServices(namespace: string = "default"): Promise<{ serviceName: string; endpointCount: number }[]> {
    const rows = await this.db.prepare("SELECT service_name, COUNT(*) as count FROM service_endpoints WHERE namespace = ? AND healthy = 1 AND datetime(last_heartbeat_at) > datetime('now', '-30 seconds') GROUP BY service_name").bind(namespace).all();

    return rows.results.map((r: any) => ({
      serviceName: r.service_name,
      endpointCount: r.count
    }));
  }

  async heartbeat(containerId: string): Promise<void> {
    await this.db.prepare("UPDATE service_endpoints SET last_heartbeat_at = ?, healthy = 1 WHERE container_id = ?").bind(nowIso(), containerId).run();
  }

  async applyTrafficPolicy(policy: Omit<TrafficPolicy, "id" | "createdAt">): Promise<TrafficPolicy> {
    const id = newId("tp");
    const createdAt = nowIso();
    
    await this.db.prepare("INSERT INTO traffic_policies (id, source_service, target_service, namespace, policy, config_json, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, policy.sourceService, policy.targetService, policy.namespace, policy.policy, JSON.stringify(policy.config), policy.priority, createdAt).run();

    return { ...policy, id, createdAt };
  }

  async evaluateTrafficPolicy(sourceService: string, targetService: string, namespace: string): Promise<{ allowed: boolean; policy?: TrafficPolicy; config?: Record<string, unknown> }> {
    const rows = await this.db.prepare("SELECT * FROM traffic_policies WHERE source_service = ? AND target_service = ? AND namespace = ? ORDER BY priority DESC").bind(sourceService, targetService, namespace).all();

    for (const row of rows.results) {
      const policy = this.mapRowToPolicy(row);
      switch (policy.policy) {
        case "allow":
          return { allowed: true, policy };
        case "deny":
          return { allowed: false, policy };
        case "rate_limit":
          return { allowed: true, policy, config: policy.config };
        case "retry":
          return { allowed: true, policy, config: policy.config };
        case "timeout":
          return { allowed: true, policy, config: policy.config };
        case "circuit_breaker":
          return { allowed: true, policy, config: policy.config };
      }
    }

    return { allowed: true };
  }

  private async issueServiceCertificate(endpoint: ServiceEndpoint): Promise<void> {
    const certId = newId("cert");
    const sans = [endpoint.serviceName + "." + endpoint.namespace + ".svc.cluster.local", "*." + endpoint.serviceName + "." + endpoint.namespace + ".svc.cluster.local"];
    
    await this.db.prepare("INSERT INTO service_certificates (id, container_id, service_name, namespace, sans_json, issued_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)").bind(certId, endpoint.containerId, endpoint.serviceName, endpoint.namespace, JSON.stringify(sans), nowIso(), new Date(Date.now() + this.mtlsConfig.certRotationHours * 3600 * 1000).toISOString()).run();
  }

  private async revokeServiceCertificate(containerId: string): Promise<void> {
    await this.db.prepare("UPDATE service_certificates SET revoked = 1, revoked_at = ? WHERE container_id = ?").bind(nowIso(), containerId).run();
  }

  async getServiceCertificate(serviceName: string, namespace: string): Promise<{ cert: string; key: string; ca: string } | null> {
    const row = await this.db.prepare("SELECT * FROM service_certificates WHERE service_name = ? AND namespace = ? AND revoked = 0 AND datetime(expires_at) > datetime('now') ORDER BY issued_at DESC LIMIT 1").bind(serviceName, namespace).first();

    if (!row) return null;

    return { cert: "", key: "", ca: this.mtlsConfig.caCert };
  }

  async runHealthChecks(): Promise<void> {
    const endpoints = await this.db.prepare("SELECT * FROM service_endpoints WHERE healthy = 1").all();

    for (const row of endpoints.results) {
      const endpoint = this.mapRowToEndpoint(row);
      if (endpoint.healthCheckPath && endpoint.protocol === "http") {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const response = await fetch("http://" + endpoint.ip + ":" + endpoint.port + endpoint.healthCheckPath, {
            signal: controller.signal
          });
          clearTimeout(timeout);
          
          if (!response.ok) {
            await this.markUnhealthy(endpoint.id);
          }
        } catch {
          await this.markUnhealthy(endpoint.id);
        }
      }
    }
  }

  private async markUnhealthy(endpointId: string): Promise<void> {
    await this.db.prepare("UPDATE service_endpoints SET healthy = 0 WHERE id = ?").bind(endpointId).run();
  }

  private mapRowToEndpoint(row: any): ServiceEndpoint {
    return {
      id: row.id,
      serviceName: row.service_name,
      namespace: row.namespace,
      containerId: row.container_id,
      ip: row.ip,
      port: row.port,
      protocol: row.protocol,
      healthCheckPath: row.health_check_path,
      metadata: JSON.parse(row.metadata_json || "{}"),
      registeredAt: row.registered_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      healthy: row.healthy === 1,
    };
  }

  private mapRowToPolicy(row: any): TrafficPolicy {
    return {
      id: row.id,
      sourceService: row.source_service,
      targetService: row.target_service,
      namespace: row.namespace,
      policy: row.policy,
      config: JSON.parse(row.config_json || "{}"),
      priority: row.priority,
      createdAt: row.created_at,
    };
  }
}

export class ServiceDiscoveryResolver {
  constructor(private mesh: ServiceMeshManager) {}

  async resolve(hostname: string): Promise<ServiceEndpoint[]> {
    const parts = hostname.split(".");
    if (parts.length < 5 || parts[2] !== "svc" || parts[3] !== "cluster" || parts[4] !== "local") {
      return [];
    }
    const serviceName = parts[0];
    const namespace = parts[1];
    if (!serviceName || !namespace) return [];
    return this.mesh.discoverServices(serviceName, namespace);
  }

  async resolveSRV(service: string, protocol: string, name: string): Promise<{ target: string; port: number; priority: number; weight: number }[]> {
    const endpoints = await this.mesh.discoverServices(name, "default");
    return endpoints.map((ep, i) => ({
      target: ep.serviceName + "." + ep.namespace + ".svc.cluster.local",
      port: ep.port,
      priority: 10,
      weight: 100 - i * 10,
    }));
  }
}

export interface SidecarConfig {
  serviceName: string;
  namespace: string;
  containerId: string;
  port: number;
  healthCheckPath?: string;
  meshControlPlaneUrl: string;
}

export function generateSidecarConfig(config: SidecarConfig): string {
  return "# CloudPress Service Mesh Sidecar\n# Auto-generated configuration for " + config.serviceName + "." + config.namespace + "\n\nenv:\n  - name: SERVICE_NAME\n    value: \"" + config.serviceName + "\"\n  - name: NAMESPACE\n    value: \"" + config.namespace + "\"\n  - name: CONTAINER_ID\n    value: \"" + config.containerId + "\"\n  - name: PORT\n    value: \"" + config.port + "\"\n  - name: HEALTH_CHECK_PATH\n    value: \"" + (config.healthCheckPath || "/") + "\"\n  - name: MESH_CONTROL_PLANE\n    value: \"" + config.meshControlPlaneUrl + "\"\n\n# mTLS certificates mounted at /etc/certs\n# Health check endpoint at /health\n# Metrics endpoint at /metrics";
}
