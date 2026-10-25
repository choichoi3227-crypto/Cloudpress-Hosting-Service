import { type D1Like, newId, nowIso } from "./db";
import { b64urlDecode, b64urlEncode } from "./crypto";

export interface R2Bucket {
  put(key: string, value: any, options?: any): Promise<any>;
  get(key: string): Promise<any>;
  delete(keys: string | string[]): Promise<void>;
}

export interface BackupPipeline {
  runBackup(jobId: string, containerId: string, databaseId: string | null, kind: "full" | "incremental" | "binlog", r2Prefix: string, encryptionKeyId: string, interceptStream: ReadableStream, totalBytes: number): Promise<void>;
  pruneBackups(containerId: string, retentionDays: number, nowMs: number): Promise<{ freedBytes: number; deletedJobs: number }>;
}

export class LiveBackupPipeline implements BackupPipeline {
  constructor(private db: D1Like, private r2: R2Bucket, private getMasterKey: (id: string) => Promise<string | null>) {}

  async runBackup(jobId: string, containerId: string, databaseId: string | null, kind: string, r2Prefix: string, encryptionKeyId: string, interceptStream: ReadableStream, totalBytes: number): Promise<void> {
    // ... (기존 업로드 로직)
  }

  /** 체인 기반 백업 정리: 보존 기간이 지났더라도 가장 최근의 Full 백업과 그 이후의 체인은 유지함 */
  async pruneBackups(containerId: string, retentionDays: number, nowMs: number): Promise<{ freedBytes: number; deletedJobs: number }> {
    const cutoff = nowIso(nowMs - retentionDays * 86400 * 1000);
    
    // 1. 삭제 후보 찾기 (보존 기간 만료)
    const { results: candidates } = await this.db.prepare(
      "SELECT id, kind, created_at FROM backup_jobs WHERE container_id = ? AND created_at < ? AND status = 'completed' ORDER BY created_at DESC"
    ).bind(containerId, cutoff).all<{ id: string; kind: string; created_at: string }>();

    // 2. 보호해야 할 최신 Full 백업 찾기
    const latestFull = await this.db.prepare(
      "SELECT id, created_at FROM backup_jobs WHERE container_id = ? AND kind = 'full' AND status = 'completed' ORDER BY created_at DESC LIMIT 1"
    ).bind(containerId).first<{ id: string; created_at: string }>();

    let freedBytes = 0;
    let deletedJobs = 0;

    for (const job of candidates) {
      // 최신 Full 백업이거나 그 이후의 증분 백업은 삭제하지 않음
      if (latestFull && job.created_at >= latestFull.created_at) continue;

      const { results: chunks } = await this.db.prepare("SELECT r2_key, size_bytes FROM backup_chunks WHERE backup_job_id = ?").bind(job.id).all<{ r2_key: string; size_bytes: number }>();
      if (chunks.length > 0) {
        await this.r2.delete(chunks.map(c => c.r2_key));
        freedBytes += chunks.reduce((a, b) => a + b.size_bytes, 0);
      }
      await this.db.prepare("DELETE FROM backup_chunks WHERE backup_job_id = ?").bind(job.id).run();
      await this.db.prepare("DELETE FROM backup_jobs WHERE id = ?").bind(job.id).run();
      deletedJobs++;
    }

    return { freedBytes, deletedJobs };
  }
}
