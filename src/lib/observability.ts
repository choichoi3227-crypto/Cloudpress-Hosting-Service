import { type D1Like, newId, nowIso } from "./db";

export interface MetricPoint {
  name: string;
  labels: Record<string, string>;
  value: number;
  timestamp: number;
}

export interface AlertRule {
  id: string;
  name: string;
  description?: string;
  metricName: string;
  condition: {
    operator: "gt" | "lt" | "gte" | "lte" | "eq" | "neq";
    threshold: number;
    durationSec: number;
  };
  severity: "info" | "warning" | "critical";
  enabled: boolean;
  notificationChannels: string[];
}

export interface AlertEvent {
  id: string;
  alertId: string;
  status: "firing" | "resolved" | "acknowledged";
  value?: number;
  labels?: Record<string, string>;
  startedAt: number;
  resolvedAt?: number;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
}

export interface SLO {
  id: string;
  name: string;
  service: string;
  sli: {
    metricName: string;
    goodCondition: Record<string, unknown>;
    totalCondition: Record<string, unknown>;
  };
  target: number;
  window: "1h" | "24h" | "7d" | "30d";
  createdAt: string;
}

export class ObservabilityManager {
  constructor(
    private db: D1Like,
    private logQueue?: any
  ) {}

  async recordMetric(name: string, labels: Record<string, string>, value: number): Promise<void> {
    const labelsJson = JSON.stringify(labels);
    
    await this.db.prepare("INSERT INTO observability_metrics (metric_name, labels_json, value, timestamp) VALUES (?, ?, ?, ?)").bind(name, labelsJson, value, nowIso()).run();

    if (this.logQueue) {
      try {
        await this.logQueue.send({ name, labels, value, timestamp: Date.now() });
      } catch {
        // Queue failure is non-blocking
      }
    }
  }

  async recordMetrics(metrics: MetricPoint[]): Promise<void> {
    for (const m of metrics) {
      await this.recordMetric(m.name, m.labels, m.value);
    }
  }

  async queryMetrics(
    name: string,
    labels: Record<string, string>,
    fromMs: number,
    toMs: number,
    aggregation: "sum" | "avg" | "min" | "max" | "count" = "avg"
  ): Promise<number[]> {
    const labelConditions = Object.entries(labels)
      .map(([k, v]) => "json_extract(labels_json, '$." + k + "') = ?")
      .join(" AND ");

    const whereClause = labelConditions 
      ? "metric_name = ? AND " + labelConditions + " AND timestamp >= ? AND timestamp <= ?"
      : "metric_name = ? AND timestamp >= ? AND timestamp <= ?";

    const params = [name, ...Object.values(labels), new Date(fromMs).toISOString(), new Date(toMs).toISOString()];

    const rows = await this.db.prepare("SELECT value FROM observability_metrics WHERE " + whereClause + " ORDER BY timestamp ASC").bind(...params).all();

    const values = rows.results.map((r: any) => r.value);
    
    switch (aggregation) {
      case "sum": return [values.reduce((a, b) => a + b, 0)];
      case "avg": return values.length > 0 ? [values.reduce((a, b) => a + b, 0) / values.length] : [0];
      case "min": return values.length > 0 ? [Math.min(...values)] : [Infinity];
      case "max": return values.length > 0 ? [Math.max(...values)] : [-Infinity];
      case "count": return [values.length];
    }
  }

  async createAlertRule(rule: Omit<AlertRule, "id">): Promise<AlertRule> {
    const id = newId("alert");
    const now = nowIso();

    await this.db.prepare("INSERT INTO observability_alerts (id, name, description, metric_name, condition_json, severity, enabled, notification_channels_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, rule.name, rule.description || null, rule.metricName, JSON.stringify(rule.condition), rule.severity, rule.enabled ? 1 : 0, JSON.stringify(rule.notificationChannels), now, now).run();

    return { ...rule, id };
  }

  async evaluateAlerts(): Promise<void> {
    const rows = await this.db.prepare("SELECT * FROM observability_alerts WHERE enabled = 1").all();

    for (const row of rows.results) {
      const alert = this.mapRowToAlert(row);
      const condition = alert.condition;

      const now = Date.now();
      const from = now - condition.durationSec * 1000;
      const values = await this.queryMetrics(alert.metricName, {}, from, now, "avg");
      
      if (values.length === 0) continue;

      const currentValue = values[0];
      if (currentValue === undefined) continue;
      const shouldFire = this.evaluateCondition(currentValue, condition.operator, condition.threshold);

      if (shouldFire) {
        await this.fireAlert(alert.id, currentValue, {});
      } else {
        await this.resolveAlert(alert.id);
      }
    }
  }

  private evaluateCondition(value: number, operator: string, threshold: number): boolean {
    switch (operator) {
      case "gt": return value > threshold;
      case "lt": return value < threshold;
      case "gte": return value >= threshold;
      case "lte": return value <= threshold;
      case "eq": return value === threshold;
      case "neq": return value !== threshold;
      default: return false;
    }
  }

  private async fireAlert(alertId: string, value: number, labels: Record<string, string>): Promise<void> {
    const existing = await this.db.prepare("SELECT id FROM observability_alert_events WHERE alert_id = ? AND status = 'firing'").bind(alertId).first();

    if (existing) return;

    const id = newId("alert_evt");
    const now = nowIso();

    await this.db.prepare("INSERT INTO observability_alert_events (id, alert_id, status, value, labels_json, started_at) VALUES (?, ?, 'firing', ?, ?, ?)").bind(id, alertId, value, JSON.stringify(labels), now).run();

    const alert = await this.db.prepare("SELECT * FROM observability_alerts WHERE id = ?").bind(alertId).first<any>();
    if (alert && this.logQueue) {
      try {
        await this.logQueue.send({
          type: "alert_firing",
          alertId,
          alertName: alert.name,
          severity: alert.severity,
          value,
          labels,
          timestamp: now
        });
      } catch {
        // Non-blocking
      }
    }
  }

  private async resolveAlert(alertId: string): Promise<void> {
    const now = nowIso();

    await this.db.prepare("UPDATE observability_alert_events SET status = 'resolved', resolved_at = ? WHERE alert_id = ? AND status = 'firing'").bind(now, alertId).run();
  }

  async acknowledgeAlert(eventId: string, userId: string): Promise<void> {
    const now = nowIso();

    await this.db.prepare("UPDATE observability_alert_events SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ? WHERE id = ?").bind(now, userId, eventId).run();
  }

  async getActiveAlerts(): Promise<AlertEvent[]> {
    const rows = await this.db.prepare("SELECT * FROM observability_alert_events WHERE status IN ('firing', 'acknowledged') ORDER BY started_at DESC").all();

    return rows.results.map(this.mapRowToAlertEvent);
  }

  async createSLO(slo: Omit<SLO, "id" | "createdAt">): Promise<SLO> {
    const id = newId("slo");
    const now = nowIso();

    await this.db.prepare("INSERT INTO observability_slos (id, name, service, sli_json, target, window, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, slo.name, slo.service, JSON.stringify(slo.sli), slo.target, slo.window, now).run();

    return { ...slo, id, createdAt: now };
  }

  async computeSLO(sloId: string): Promise<{ met: boolean; current: number; target: number; errorBudgetRemaining: number }> {
    const row = await this.db.prepare("SELECT * FROM observability_slos WHERE id = ?").bind(sloId).first<any>();
    if (!row) throw new Error("SLO not found");

    const slo = { ...row, sli: JSON.parse(row.sli_json) };
    const windowMs = this.parseWindow(slo.window);
    const now = Date.now();
    const from = now - windowMs;

    const [goodResult, totalResult] = await Promise.all([
      this.queryMetrics(slo.sli.metricName, slo.sli.goodCondition, from, now, "count"),
      this.queryMetrics(slo.sli.metricName, slo.sli.totalCondition, from, now, "count")
    ]);

    const good = goodResult[0] || 0;
    const total = totalResult[0] || 1;
    const current = (good / total) * 100;
    const met = current >= slo.target;
    const errorBudgetRemaining = ((current - slo.target) / (100 - slo.target)) * 100;

    return { met, current, target: slo.target, errorBudgetRemaining };
  }

  private parseWindow(window: string): number {
    const unit = window.slice(-1);
    const value = parseInt(window.slice(0, -1));
    switch (unit) {
      case "h": return value * 3600 * 1000;
      case "d": return value * 24 * 3600 * 1000;
      default: return 24 * 3600 * 1000;
    }
  }

  private mapRowToAlert(row: any): AlertRule {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      metricName: row.metric_name,
      condition: JSON.parse(row.condition_json),
      severity: row.severity,
      enabled: row.enabled === 1,
      notificationChannels: JSON.parse(row.notification_channels_json || "[]")
    };
  }

  private mapRowToAlertEvent(row: any): AlertEvent {
    return {
      id: row.id,
      alertId: row.alert_id,
      status: row.status,
      value: row.value,
      labels: row.labels_json ? JSON.parse(row.labels_json) : undefined,
      startedAt: Date.parse(row.started_at),
      resolvedAt: row.resolved_at ? Date.parse(row.resolved_at) : undefined,
      acknowledgedAt: row.acknowledged_at ? Date.parse(row.acknowledged_at) : undefined,
      acknowledgedBy: row.acknowledged_by
    };
  }
}

export function createMetricsCollector(obs: ObservabilityManager) {
  return {
    increment: (name: string, labels: Record<string, string> = {}, value = 1) => obs.recordMetric(name, labels, value),
    gauge: (name: string, labels: Record<string, string>, value: number) => obs.recordMetric(name, labels, value),
    histogram: (name: string, labels: Record<string, string>, value: number) => obs.recordMetric(name, labels, value),
    timing: (name: string, labels: Record<string, string>, ms: number) => obs.recordMetric(name, labels, ms)
  };
}
