import { type D1Like, newId, nowIso } from "./db";

export interface DatabaseReplica {
  id: string;
  databaseId: string;
  replicaType: "sync" | "async" | "cascade";
  endpointHost: string;
  endpointPort: number;
  status: "provisioning" | "healthy" | "lagging" | "unhealthy" | "deleting" | "deleted";
  replicationLagMs?: number;
  lastCheckAt?: string;
  createdAt: string;
}

export interface ConnectionPool {
  id: string;
  databaseId: string;
  poolName: string;
  minConnections: number;
  maxConnections: number;
  idleTimeoutSec: number;
  maxLifetimeSec: number;
}

export interface PITRSnapshot {
  id: string;
  databaseId: string;
  r2Key: string;
  walStartLsn?: string;
  walEndLsn?: string;
  sizeBytes?: number;
  createdAt: string;
  expiresAt: string;
}

export interface R2Bucket {
  put(key: string, value: any): Promise<void>;
  get(key: string): Promise<any>;
  delete(key: string): Promise<void>;
}

export class DatabaseManager {
  constructor(
    private db: D1Like,
    private r2: R2Bucket,
    private cfClient: any,
    private encryptionKey: string
  ) {}

  async createReplica(params: Omit<DatabaseReplica, "id" | "status" | "createdAt">): Promise<DatabaseReplica> {
    const id = newId("dbrep");
    const now = nowIso();

    await this.db.prepare("INSERT INTO database_replicas (id, database_id, replica_type, endpoint_host, endpoint_port, status, created_at) VALUES (?, ?, ?, ?, ?, 'provisioning', ?)").bind(id, params.databaseId, params.replicaType, params.endpointHost, params.endpointPort, now).run();

    return { ...params, id, status: "provisioning", createdAt: now };
  }

  async createReadReplica(databaseId: string, replicaType: "sync" | "async" = "async"): Promise<DatabaseReplica> {
    const db = await this.db.prepare("SELECT * FROM databases WHERE id = ?").bind(databaseId).first<any>();
    if (!db) throw new Error("Database not found");

    const replicaId = newId("dbrep");
    const now = nowIso();
    const port = db.provider === "cloudb_container" ? 3306 : 5432;

    await this.db.prepare("INSERT INTO database_replicas (id, database_id, replica_type, endpoint_host, endpoint_port, status, created_at) VALUES (?, ?, ?, 'pending', ?, 'provisioning', ?)").bind(replicaId, databaseId, replicaType, port, now).run();

    if (db.provider === "cloudb_container") {
      await this.provisionCloudBReplica(db, replicaId);
    } else if (db.provider === "supabase") {
      await this.provisionSupabaseReplica(db, replicaId);
    }

    return {
      id: replicaId,
      databaseId,
      replicaType,
      endpointHost: "pending",
      endpointPort: port,
      status: "provisioning",
      createdAt: now
    };
  }

  private async provisionCloudBReplica(db: any, replicaId: string): Promise<void> {
    await this.cfClient.startContainer({
      containerId: "replica-" + replicaId,
      image: "cloudb-mariadb:latest",
      instanceType: "standard-1",
      enableInternet: false,
      entrypoint: "mariadb --replica",
      env: {
        MYSQL_REPLICA: "1",
        MYSQL_SOURCE_HOST: db.container_id,
        MYSQL_SOURCE_USER: "replicator",
        MYSQL_SOURCE_PASSWORD: await this.getReplicationPassword(db.id)
      },
      labels: { "cloudpress/replica-of": db.id }
    });
  }

  private async provisionSupabaseReplica(db: any, replicaId: string): Promise<void> {
    await this.cfClient.startContainer({
      containerId: "replica-" + replicaId,
      image: "supabase/postgres:latest",
      instanceType: "standard-1",
      enableInternet: false,
      entrypoint: "postgres -c wal_level=replica -c max_wal_senders=10",
      env: {
        POSTGRES_REPLICATION: "on",
        POSTGRES_SOURCE_HOST: db.external_project_ref,
        POSTGRES_REPLICATION_USER: "replicator",
        POSTGRES_REPLICATION_PASSWORD: await this.getReplicationPassword(db.id)
      },
      labels: { "cloudpress/replica-of": db.id }
    });
  }

  private async getReplicationPassword(databaseId: string): Promise<string> {
    const row = await this.db.prepare("SELECT secret_ref FROM databases WHERE id = ?").bind(databaseId).first<{ secret_ref: string }>();
    if (!row?.secret_ref) throw new Error("No secret reference");
    
    const secret = await this.db.prepare("SELECT value FROM secrets WHERE id = ?").bind(row.secret_ref).first<{ value: string }>();
    return secret?.value || "";
  }

  async createConnectionPool(params: Omit<ConnectionPool, "id">): Promise<ConnectionPool> {
    const id = newId("pool");
    await this.db.prepare("INSERT INTO database_connection_pools (id, database_id, pool_name, min_connections, max_connections, idle_timeout_sec, max_lifetime_sec) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, params.databaseId, params.poolName, params.minConnections, params.maxConnections, params.idleTimeoutSec, params.maxLifetimeSec).run();

    return { ...params, id };
  }

  async getConnectionPool(databaseId: string, poolName: string): Promise<ConnectionPool | null> {
    const row = await this.db.prepare("SELECT * FROM database_connection_pools WHERE database_id = ? AND pool_name = ?").bind(databaseId, poolName).first<any>();
    if (!row) return null;
    return {
      id: row.id,
      databaseId: row.database_id,
      poolName: row.pool_name,
      minConnections: row.min_connections,
      maxConnections: row.max_connections,
      idleTimeoutSec: row.idle_timeout_sec,
      maxLifetimeSec: row.max_lifetime_sec
    };
  }

  async createPITRSnapshot(databaseId: string): Promise<PITRSnapshot> {
    const id = newId("pitr");
    const r2Key = "pitr/" + databaseId + "/" + id + ".bin";
    const now = nowIso();

    await this.db.prepare("INSERT INTO database_pitr_snapshots (id, database_id, r2_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(id, databaseId, r2Key, now, new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()).run();

    return {
      id,
      databaseId,
      r2Key,
      createdAt: now,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    };
  }

  async restoreFromPITR(databaseId: string, targetTimestamp: number): Promise<{ containerId: string; endpoint: string }> {
    const snapshots = await this.db.prepare("SELECT * FROM database_pitr_snapshots WHERE database_id = ? AND datetime(created_at) <= ? ORDER BY created_at DESC LIMIT 1").bind(databaseId, new Date(targetTimestamp).toISOString()).all();

    if (snapshots.results.length === 0) {
      throw new Error("No PITR snapshot available for target timestamp");
    }

    const snapshot = snapshots.results[0];
    
    const replicaId = newId("pitr_restore");
    await this.cfClient.startContainer({
      containerId: "pitr-restore-" + replicaId,
      image: "cloudb-mariadb:latest",
      instanceType: "standard-1",
      enableInternet: false,
      entrypoint: "mariadb --restore",
      env: {
        RESTORE_FROM_R2: snapshot.r2_key,
        RESTORE_TIMESTAMP: String(targetTimestamp),
        MYSQL_ROOT_PASSWORD: await this.generateTempPassword()
      },
      labels: { "cloudpress/pitr-restore": "true", "cloudpress/source-db": databaseId }
    });

    const status = await this.cfClient.getContainerStatus("pitr-restore-" + replicaId);
    return { containerId: status.cfInstanceId || "", endpoint: status.ip + ":" + status.port };
  }

  async checkReplicaHealth(replicaId: string): Promise<void> {
    const replica = await this.db.prepare("SELECT * FROM database_replicas WHERE id = ?").bind(replicaId).first<any>();
    if (!replica) throw new Error("Replica not found");

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch("http://" + replica.endpoint_host + ":" + replica.endpoint_port + "/health", { signal: controller.signal });
      clearTimeout(timeout);

      if (response.ok) {
        await this.db.prepare("UPDATE database_replicas SET status = 'healthy', last_check_at = ? WHERE id = ?").bind(nowIso(), replicaId).run();
      } else {
        await this.markLagging(replicaId);
      }
    } catch {
      await this.markUnhealthy(replicaId);
    }
  }

  private async markLagging(replicaId: string): Promise<void> {
    await this.db.prepare("UPDATE database_replicas SET status = 'lagging', last_check_at = ? WHERE id = ?").bind(nowIso(), replicaId).run();
  }

  private async markUnhealthy(replicaId: string): Promise<void> {
    await this.db.prepare("UPDATE database_replicas SET status = 'unhealthy', last_check_at = ? WHERE id = ?").bind(nowIso(), replicaId).run();
  }

  private async generateTempPassword(): Promise<string> {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, "0")).join("");
  }
}
