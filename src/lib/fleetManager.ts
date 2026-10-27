import { type D1Like, newId, nowIso } from "./db";
import { type ContainerManager } from "./containerManager";

export interface DeploymentStrategy {
  type: "rolling" | "canary" | "blue_green" | "recreate";
  maxSurge?: number;
  maxUnavailable?: number;
  canarySteps?: { weight: number; pauseSec: number }[];
  preDeployHooks?: string[];
  postDeployHooks?: string[];
}

export interface FleetDeployment {
  id: string;
  name: string;
  subscriptionId: string;
  strategy: DeploymentStrategy;
  status: "pending" | "running" | "succeeded" | "failed" | "rolled_back" | "paused";
  currentStep: number;
  totalSteps: number;
  targetVersion: string;
  previousVersion?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface FleetRollback {
  id: string;
  deploymentId: string;
  reason: string;
  initiatedBy: string;
  status: "pending" | "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
}

export class FleetManager {
  constructor(
    private db: D1Like,
    private containerManager: ContainerManager,
    private serviceMesh: any
  ) {}

  async createDeployment(
    subscriptionId: string,
    name: string,
    targetVersion: string,
    strategy: DeploymentStrategy
  ): Promise<FleetDeployment> {
    const id = newId("deploy");
    const now = nowIso();
    const totalSteps = this.calculateSteps(strategy);

    await this.db.prepare("INSERT INTO fleet_deployments (id, name, subscription_id, strategy_json, status, current_step, total_steps, target_version, started_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)").bind(id, name, subscriptionId, JSON.stringify(strategy), totalSteps, targetVersion, now).run();

    return {
      id,
      name,
      subscriptionId,
      strategy,
      status: "pending",
      currentStep: 0,
      totalSteps,
      targetVersion,
      startedAt: now
    };
  }

  async executeDeployment(deploymentId: string): Promise<void> {
    const deployment = await this.getDeployment(deploymentId);
    if (!deployment) throw new Error("Deployment not found");
    if (deployment.status !== "pending" && deployment.status !== "paused") {
      throw new Error("Deployment cannot be executed in current state");
    }

    await this.updateDeploymentStatus(deploymentId, "running");

    try {
      switch (deployment.strategy.type) {
        case "rolling":
          await this.executeRolling(deployment);
          break;
        case "canary":
          await this.executeCanary(deployment);
          break;
        case "blue_green":
          await this.executeBlueGreen(deployment);
          break;
        case "recreate":
          await this.executeRecreate(deployment);
          break;
      }
      await this.updateDeploymentStatus(deploymentId, "succeeded", deployment.currentStep);
      await this.runPostDeployHooks(deployment);
    } catch (error: any) {
      await this.updateDeploymentStatus(deploymentId, "failed", deployment.currentStep, error.message);
      if (deployment.strategy.type !== "recreate") {
        await this.rollback(deploymentId, "automatic on failure");
      }
      throw error;
    }
  }

  private calculateSteps(strategy: DeploymentStrategy): number {
    switch (strategy.type) {
      case "rolling": return strategy.maxSurge ? Math.ceil(100 / strategy.maxSurge) : 5;
      case "canary": return (strategy.canarySteps?.length || 3) + 1;
      case "blue_green": return 3;
      case "recreate": return 2;
      default: return 5;
    }
  }

  private async executeRolling(deployment: FleetDeployment): Promise<void> {
    const containers = await this.getContainersForDeployment(deployment.subscriptionId);
    const batchSize = deployment.strategy.maxSurge || Math.ceil(containers.length / 5);
    
    for (let i = 0; i < containers.length; i += batchSize) {
      await this.runPreDeployHooks(deployment);
      
      const batch = containers.slice(i, i + batchSize);
      await Promise.all(batch.map(c => this.containerManager.resize(c.id, deployment.targetVersion as any)));
      
      await this.waitForHealthy(batch);
      
      deployment.currentStep++;
      await this.updateDeploymentProgress(deployment.id, deployment.currentStep);
      
      if (deployment.strategy.maxUnavailable && i + batchSize < containers.length) {
        await this.waitForHealthy(containers.slice(i + batchSize, i + batchSize + deployment.strategy.maxUnavailable));
      }
    }
  }

  private async executeCanary(deployment: FleetDeployment): Promise<void> {
    const containers = await this.getContainersForDeployment(deployment.subscriptionId);
    const canaryContainers = containers.slice(0, Math.ceil(containers.length * 0.1));
    const productionContainers = containers.slice(Math.ceil(containers.length * 0.1));

    const steps = deployment.strategy.canarySteps || [
      { weight: 10, pauseSec: 300 },
      { weight: 50, pauseSec: 300 },
      { weight: 100, pauseSec: 0 }
    ];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      
      await this.serviceMesh.applyTrafficPolicy({
        sourceService: "ingress",
        targetService: deployment.name,
        namespace: "default",
        policy: "rate_limit",
        config: { canaryWeight: step.weight },
        priority: 100 - i
      });

      await this.updateDeploymentProgress(deployment.id, ++deployment.currentStep);

      if (step.pauseSec > 0) {
        await new Promise(r => setTimeout(r, step.pauseSec * 1000));
        const metrics = await this.checkCanaryMetrics(deployment);
        if (!metrics.healthy) {
          throw new Error("Canary metrics unhealthy at step " + (i + 1) + ": " + metrics.reason);
        }
      }
    }

    await Promise.all(productionContainers.map(c => this.containerManager.resize(c.id, deployment.targetVersion as any)));
    await this.waitForHealthy(productionContainers);
    await this.updateDeploymentProgress(deployment.id, ++deployment.currentStep);
  }

  private async executeBlueGreen(deployment: FleetDeployment): Promise<void> {
    const containers = await this.getContainersForDeployment(deployment.subscriptionId);
    const midPoint = Math.ceil(containers.length / 2);
    const green = containers.slice(0, midPoint);
    const blue = containers.slice(midPoint);

    await Promise.all(green.map(c => this.containerManager.resize(c.id, deployment.targetVersion as any)));
    await this.waitForHealthy(green);
    await this.updateDeploymentProgress(deployment.id, ++deployment.currentStep);

    await this.serviceMesh.applyTrafficPolicy({
      sourceService: "ingress",
      targetService: deployment.name,
      namespace: "default",
      policy: "allow",
      config: { targetGroup: "green" },
      priority: 100
    });
    await this.updateDeploymentProgress(deployment.id, ++deployment.currentStep);

    await Promise.all(blue.map(c => this.containerManager.resize(c.id, deployment.targetVersion as any)));
    await this.waitForHealthy(blue);
    await this.updateDeploymentProgress(deployment.id, ++deployment.currentStep);

    deployment.previousVersion = deployment.targetVersion;
  }

  private async executeRecreate(deployment: FleetDeployment): Promise<void> {
    const containers = await this.getContainersForDeployment(deployment.subscriptionId);
    
    await Promise.all(containers.map(c => this.containerManager.suspend(c.id)));
    await this.updateDeploymentProgress(deployment.id, ++deployment.currentStep);

    await Promise.all(containers.map(c => this.containerManager.resize(c.id, deployment.targetVersion as any)));
    await Promise.all(containers.map(c => this.containerManager.resume(c.id)));
    await this.waitForHealthy(containers);
    await this.updateDeploymentProgress(deployment.id, ++deployment.currentStep);
  }

  async rollback(deploymentId: string, reason: string): Promise<FleetRollback> {
    const deployment = await this.getDeployment(deploymentId);
    if (!deployment) throw new Error("Deployment not found");
    if (!deployment.previousVersion) throw new Error("No previous version to rollback to");

    const rollbackId = newId("rb");
    const now = nowIso();

    await this.db.prepare("INSERT INTO fleet_rollbacks (id, deployment_id, reason, initiated_by, status, started_at) VALUES (?, ?, ?, 'system', 'running', ?)").bind(rollbackId, deploymentId, reason, now).run();

    try {
      const containers = await this.getContainersForDeployment(deployment.subscriptionId);
      await Promise.all(containers.map(c => this.containerManager.resize(c.id, deployment.previousVersion as any)));
      await this.waitForHealthy(containers);

      await this.serviceMesh.applyTrafficPolicy({
        sourceService: "ingress",
        targetService: deployment.name,
        namespace: "default",
        policy: "allow",
        config: { targetGroup: "all" },
        priority: 100
      });

      await this.db.prepare("UPDATE fleet_rollbacks SET status = 'succeeded', completed_at = ? WHERE id = ?").bind(nowIso(), rollbackId).run();
      await this.db.prepare("UPDATE fleet_deployments SET status = 'rolled_back' WHERE id = ?").bind(deploymentId).run();

      return { id: rollbackId, deploymentId, reason, initiatedBy: "system", status: "succeeded", startedAt: now, completedAt: nowIso() };
    } catch (error: any) {
      await this.db.prepare("UPDATE fleet_rollbacks SET status = 'failed' WHERE id = ?").bind(rollbackId).run();
      throw error;
    }
  }

  async pauseDeployment(deploymentId: string): Promise<void> {
    await this.db.prepare("UPDATE fleet_deployments SET status = 'paused' WHERE id = ? AND status = 'running'").bind(deploymentId).run();
  }

  async resumeDeployment(deploymentId: string): Promise<void> {
    const deployment = await this.getDeployment(deploymentId);
    if (!deployment || deployment.status !== "paused") throw new Error("Cannot resume");
    await this.executeDeployment(deploymentId);
  }

  private async getContainersForDeployment(subscriptionId: string): Promise<{ id: string }[]> {
    const rows = await this.db.prepare("SELECT id FROM containers WHERE subscription_id = ? AND state = 'running'").bind(subscriptionId).all();
    return rows.results.map((r: any) => ({ id: r.id }));
  }

  private async waitForHealthy(containers: { id: string }[]): Promise<void> {
    const maxWait = 300000;
    const start = Date.now();
    
    while (Date.now() - start < maxWait) {
      const statuses = await Promise.all(containers.map(c => this.containerManager.getStatus(c.id)));
      if (statuses.every(s => s.state === "running")) return;
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error("Containers did not become healthy in time");
  }

  private async checkCanaryMetrics(deployment: FleetDeployment): Promise<{ healthy: boolean; reason?: string }> {
    return { healthy: true };
  }

  private async runPreDeployHooks(deployment: FleetDeployment): Promise<void> {
    for (const hook of deployment.strategy.preDeployHooks || []) {
      await this.executeHook(hook);
    }
  }

  private async runPostDeployHooks(deployment: FleetDeployment): Promise<void> {
    for (const hook of deployment.strategy.postDeployHooks || []) {
      await this.executeHook(hook);
    }
  }

  private async executeHook(hook: string): Promise<void> {
    console.log("Executing hook: " + hook);
  }

  private async getDeployment(id: string): Promise<FleetDeployment | null> {
    const row = await this.db.prepare("SELECT * FROM fleet_deployments WHERE id = ?").bind(id).first<any>();
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      subscriptionId: row.subscription_id,
      strategy: JSON.parse(row.strategy_json),
      status: row.status,
      currentStep: row.current_step,
      totalSteps: row.total_steps,
      targetVersion: row.target_version,
      previousVersion: row.previous_version,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error
    };
  }

  private async updateDeploymentStatus(id: string, status: FleetDeployment["status"], step?: number, error?: string): Promise<void> {
    const updates = ["status = ?"];
    const params: any[] = [status];
    if (step !== undefined) { updates.push("current_step = ?"); params.push(step); }
    if (status === "succeeded" || status === "failed" || status === "rolled_back") { updates.push("completed_at = ?"); params.push(nowIso()); }
    if (error) { updates.push("error = ?"); params.push(error); }
    params.push(id);
    
    await this.db.prepare("UPDATE fleet_deployments SET " + updates.join(", ") + " WHERE id = ?").bind(...params).run();
  }

  private async updateDeploymentProgress(id: string, step: number): Promise<void> {
    await this.db.prepare("UPDATE fleet_deployments SET current_step = ? WHERE id = ?").bind(step, id).run();
  }
}
