import { type D1Like, newId, nowIso } from "./db";

export interface GatewayRoute {
  id: string;
  name: string;
  pathPattern: string;
  methods: string[];
  targetService?: string;
  targetUrl?: string;
  stripPathPrefix: boolean;
  timeoutMs: number;
  retries: number;
  retryBackoffMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerTimeoutSec: number;
  authRequired: boolean;
  roles?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RouteTransform {
  id: string;
  routeId: string;
  phase: "request" | "response";
  transformType: "add_header" | "remove_header" | "rewrite_path" | "rewrite_body" | "add_query" | "remove_query";
  matchCondition?: Record<string, unknown>;
  config: Record<string, unknown>;
  priority: number;
}

export interface RateLimitRule {
  id: string;
  routeId?: string;
  scope: "global" | "route" | "ip" | "user" | "api_key";
  limitRequests: number;
  windowSec: number;
  keyPrefix?: string;
}

export class ApiGateway {
  private circuitBreakers = new Map<string, { failures: number; state: "closed" | "open" | "half-open"; nextAttemptAt: number }>();

  constructor(
    private db: D1Like,
    private rateLimiter: any
  ) {}

  async createRoute(params: Omit<GatewayRoute, "id" | "createdAt" | "updatedAt">): Promise<GatewayRoute> {
    const id = newId("route");
    const now = nowIso();
    
    await this.db.prepare("INSERT INTO api_gateway_routes (id, name, path_pattern, methods_json, target_service, target_url, strip_path_prefix, timeout_ms, retries, retry_backoff_ms, circuit_breaker_threshold, circuit_breaker_timeout_sec, auth_required, roles_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
      id, params.name, params.pathPattern, JSON.stringify(params.methods),
      params.targetService || null, params.targetUrl || null,
      params.stripPathPrefix ? 1 : 0, params.timeoutMs, params.retries,
      params.retryBackoffMs, params.circuitBreakerThreshold, params.circuitBreakerTimeoutSec,
      params.authRequired ? 1 : 0, params.roles ? JSON.stringify(params.roles) : null,
      now, now
    ).run();

    return { ...params, id, createdAt: now, updatedAt: now };
  }

  async matchRoute(path: string, method: string): Promise<GatewayRoute | null> {
    const rows = await this.db.prepare("SELECT * FROM api_gateway_routes").all();
    for (const row of rows.results) {
      const route = this.mapRowToRoute(row);
      if (route.methods.includes(method) && this.matchPathPattern(path, route.pathPattern)) {
        return route;
      }
    }
    return null;
  }

  async handleProxyRequest(req: Request, route: GatewayRoute, clientIp: string, userId?: string): Promise<Response> {
    const cbKey = route.id;
    const cb = this.circuitBreakers.get(cbKey) || { failures: 0, state: "closed", nextAttemptAt: 0 };
    
    if (cb.state === "open") {
      if (Date.now() < cb.nextAttemptAt) {
        return new Response(JSON.stringify({ error: "circuit_breaker_open", message: "Service temporarily unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        });
      }
      cb.state = "half-open";
    }

    const rateLimitKey = route.id + ":" + clientIp + ":" + (userId || "anonymous");
    const rl = await this.rateLimiter.hit(rateLimitKey, 100, 60, Date.now());
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: "rate_limited", retryAfterSec: rl.retryAfterSec }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(rl.retryAfterSec) }
      });
    }

    const transforms = await this.getRouteTransforms(route.id, "request");
    let modifiedReq = await this.applyRequestTransforms(req, transforms);

    let targetUrl = route.targetUrl;
    if (!targetUrl && route.targetService) {
      targetUrl = "http://" + route.targetService + ".default.svc.cluster.local";
    }

    if (!targetUrl) {
      return new Response(JSON.stringify({ error: "bad_gateway", message: "No target service configured" }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
    }

    const url = new URL(modifiedReq.url);
    let targetPath = url.pathname;
    if (route.stripPathPrefix) {
      const prefix = route.pathPattern.replace(/\/\\*$/, "");
      targetPath = targetPath.replace(new RegExp("^" + prefix), "") || "/";
    }

    const fullTargetUrl = targetUrl + targetPath + url.search;

    let response = null;
    let attempts = 0;
    
    while (attempts <= route.retries) {
      attempts++;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), route.timeoutMs);
        
        response = await fetch(fullTargetUrl, {
          method: modifiedReq.method,
          headers: modifiedReq.headers,
          body: modifiedReq.body,
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (response.ok || response.status < 500) {
          if (cb.state === "half-open") {
            cb.state = "closed";
            cb.failures = 0;
          }
          break;
        } else {
          cb.failures++;
        }
      } catch (e) {
        cb.failures++;
      }

      if (cb.failures >= route.circuitBreakerThreshold) {
        cb.state = "open";
        cb.nextAttemptAt = Date.now() + route.circuitBreakerTimeoutSec * 1000;
        this.circuitBreakers.set(cbKey, cb);
        break;
      }

      if (attempts <= route.retries) {
        await new Promise(r => setTimeout(r, route.retryBackoffMs * Math.pow(2, attempts - 1)));
      }
    }

    this.circuitBreakers.set(cbKey, cb);

    if (!response) {
      return new Response(JSON.stringify({ error: "upstream_timeout", message: "Upstream service failed to respond" }), {
        status: 504,
        headers: { "Content-Type": "application/json" }
      });
    }

    const respTransforms = await this.getRouteTransforms(route.id, "response");
    return this.applyResponseTransforms(response, respTransforms);
  }

  private matchPathPattern(path: string, pattern: string): boolean {
    const regexPattern = pattern
      .replace(/\/\\*/g, "/.*")
      .replace(/:([a-zA-Z0-9_]+)/g, "[^/]+");
    return new RegExp("^" + regexPattern + "$").test(path);
  }

  private async getRouteTransforms(routeId: string, phase: "request" | "response"): Promise<RouteTransform[]> {
    const rows = await this.db.prepare("SELECT * FROM api_gateway_transforms WHERE route_id = ? AND phase = ? ORDER BY priority ASC").bind(routeId, phase).all();

    return rows.results.map((r: any) => ({
      id: r.id,
      routeId: r.route_id,
      phase: r.phase,
      transformType: r.transform_type,
      matchCondition: r.match_condition_json ? JSON.parse(r.match_condition_json) : undefined,
      config: JSON.parse(r.config_json),
      priority: r.priority
    }));
  }

  private async applyRequestTransforms(req: Request, transforms: RouteTransform[]): Promise<Request> {
    const headers = new Headers(req.headers);
    for (const t of transforms) {
      if (t.transformType === "add_header") {
        for (const [k, v] of Object.entries(t.config)) {
          headers.set(k, String(v));
        }
      } else if (t.transformType === "remove_header") {
        if (typeof t.config.header === "string") {
          headers.delete(t.config.header);
        }
      }
    }
    return new Request(req.url, { method: req.method, headers, body: req.body });
  }

  private async applyResponseTransforms(resp: Response, transforms: RouteTransform[]): Promise<Response> {
    const headers = new Headers(resp.headers);
    for (const t of transforms) {
      if (t.transformType === "add_header") {
        for (const [k, v] of Object.entries(t.config)) {
          headers.set(k, String(v));
        }
      } else if (t.transformType === "remove_header") {
        if (typeof t.config.header === "string") {
          headers.delete(t.config.header);
        }
      }
    }
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
  }

  private mapRowToRoute(row: any): GatewayRoute {
    return {
      id: row.id,
      name: row.name,
      pathPattern: row.path_pattern,
      methods: JSON.parse(row.methods_json),
      targetService: row.target_service,
      targetUrl: row.target_url,
      stripPathPrefix: row.strip_path_prefix === 1,
      timeoutMs: row.timeout_ms,
      retries: row.retries,
      retryBackoffMs: row.retry_backoff_ms,
      circuitBreakerThreshold: row.circuit_breaker_threshold,
      circuitBreakerTimeoutSec: row.circuit_breaker_timeout_sec,
      authRequired: row.auth_required === 1,
      roles: row.roles_json ? JSON.parse(row.roles_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
