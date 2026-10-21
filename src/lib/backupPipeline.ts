import { type D1Like, newId, nowIso } from "./db";
import { b64urlDecode, b64urlEncode } from "./crypto";

const CHUNK_SIZE = 5 * 1024 * 1024;
const IV_LENGTH = 12;

export interface R2Bucket {
  put(key: string, value: any, options?: any): Promise<any>;
  get(key: string): Promise<any>;
  delete(keys: string | string[]): Promise<void>;
}

export interface BackupPipeline {
  runBackup(jobId: string, containerId: string, databaseId: string | null, kind: "full" | "incremental" | "binlog", r2Prefix: string, encryptionKeyId: string, interceptStream: ReadableStream, totalBytes: number): Promise<void>;
  pruneBackups(containerId: string, encryptionKeyId: string, retentionDays: number, nowMs: number): Promise<{ freedBytes: number; deletedChunks: number }>;
}

export async function deriveKey(masterKeyB64: string, saltB64: string, info: string): Promise<CryptoKey> {
  const masterKey = await crypto.subtle.importKey("raw", b64urlDecode(masterKeyB64), { name: "HKDF" }, false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: b64urlDecode(saltB64), info: new TextEncoder().encode(info) },
    masterKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export class LiveBackupPipeline implements BackupPipeline {
  constructor(private db: D1Like, private r2: R2Bucket, private getMasterKey: (encryptionKeyId: string) => Promise<string | null>) {}

  async runBackup(jobId: string, containerId: string, databaseId: string | null, kind: string, r2Prefix: string, encryptionKeyId: string, interceptStream: ReadableStream, totalBytes: number): Promise<void> {
    await this.db.prepare("UPDATE backup_jobs SET status='running', started_at=? WHERE id=?").bind(nowIso(), jobId).run();
    const masterKeyB64 = await this.getMasterKey(encryptionKeyId);
    if (!masterKeyB64) throw new Error("encryption_key_not_found");
    
    let chunkIndex = 0;
    const reader = interceptStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const derivedKey = await deriveKey(masterKeyB64, b64urlEncode(salt), `backup-chunk-${jobId}-${chunkIndex}`);
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, derivedKey, chunk);
      const r2Key = `${r2Prefix}chunk-${chunkIndex}.enc`;
      await this.r2.put(r2Key, new Uint8Array(encrypted), { customMetadata: { salt: b64urlEncode(salt), iv: b64urlEncode(iv) } });
      await this.db.prepare("INSERT INTO backup_chunks (id, backup_job_id, chunk_index, r2_key, size_bytes, sha256, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(newId("bchk"), jobId, chunkIndex, r2Key, encrypted.byteLength, "", nowIso()).run();
      chunkIndex++;
    }
    await this.db.prepare("UPDATE backup_jobs SET status='completed', completed_at=? WHERE id=?").bind(nowIso(), jobId).run();
  }

  async pruneBackups(containerId: string, encryptionKeyId: string, retentionDays: number, nowMs: number): Promise<{ freedBytes: number; deletedChunks: number }> {
    return { freedBytes: 0, deletedChunks: 0 };
  }
}

export function createBackupPipeline(env: { mode: "mock" | "live"; db: D1Like; r2Bucket?: R2Bucket }): BackupPipeline {
  if (env.mode === "mock") {
    return { async runBackup() {}, async pruneBackups() { return { freedBytes: 0, deletedChunks: 0 }; } };
  }
  if (!env.r2Bucket) throw new Error("R2Bucket required");
  const getMasterKey = async (encryptionKeyId: string) => {
    const row = await env.db.prepare("SELECT key_material_b64 FROM container_encryption_keys WHERE id = ?").bind(encryptionKeyId).first<{ key_material_b64: string }>();
    return row?.key_material_b64 ?? null;
  };
  return new LiveBackupPipeline(env.db, env.r2Bucket, getMasterKey);
}
