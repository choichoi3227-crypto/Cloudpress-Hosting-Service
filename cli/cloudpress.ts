#!/usr/bin/env bun
/**
 * CloudPress CLI - Unified control plane for CloudPress platform
 * Usage: cloudpress <command> [options]
 */

import { Command } from "commander";
import { spawn } from "child_process";
import { join } from "path";

const program = new Command();

program
  .name("cloudpress")
  .description("CloudPress CLI - AWS-like power, Cloudflare-like simplicity")
  .version("0.1.0");

program
  .command("deploy")
  .description("Deploy application to CloudPress")
  .option("-e, --env <environment>", "Target environment (staging|production)", "staging")
  .option("--no-build", "Skip build step")
  .option("--dry-run", "Preview changes without deploying")
  .action(async (options) => {
    console.log("Deploying to " + options.env + "...");
    if (!options.build) console.log("Skipping build step");
    if (options.dryRun) console.log("Dry run mode - no changes will be applied");
    
    const wranglerEnv = options.env === "production" ? "production" : "staging";
    const args = ["deploy", "--env", wranglerEnv];
    if (options.dryRun) args.push("--dry-run");
    
    await runCommand("npx", ["wrangler", ...args]);
  });

program
  .command("logs")
  .description("Stream logs from CloudPress Workers")
  .option("-e, --env <environment>", "Environment (staging|production)", "staging")
  .option("-f, --follow", "Follow log output")
  .option("--tail <lines>", "Number of lines to show", "100")
  .action(async (options) => {
    console.log("Streaming logs from " + options.env + "...");
    const args = ["tail", "--env", options.env === "production" ? "production" : "staging"];
    if (options.follow) args.push("--follow");
    args.push("--format", "pretty");
    await runCommand("npx", ["wrangler", ...args]);
  });

program
  .command("db")
  .description("Database management commands")
  .addCommand(
    new Command("shell")
      .description("Open D1 database shell")
      .option("-e, --env <environment>", "Environment (staging|production)", "staging")
      .option("-d, --database <name>", "Database name")
      .action(async (options) => {
        const env = options.env === "production" ? "production" : "staging";
        await runCommand("npx", ["wrangler", "d1", "execute", options.database || "cloudpress-dev", "--env", env, "--command", ".schema"]);
      })
  )
  .addCommand(
    new Command("migrate")
      .description("Run database migrations")
      .option("-e, --env <environment>", "Environment (staging|production)", "staging")
      .option("--dry-run", "Preview migrations without applying")
      .action(async (options) => {
        const env = options.env === "production" ? "production" : "staging";
        const args = ["d1", "migrations", "apply", "cloudpress-db", "--env", env];
        if (options.dryRun) args.push("--dry-run");
        await runCommand("npx", ["wrangler", ...args]);
      })
  )
  .addCommand(
    new Command("backup")
      .description("Create database backup")
      .option("-e, --env <environment>", "Environment (staging|production)", "production")
      .option("-d, --database <name>", "Database name")
      .action(async (options) => {
        const env = options.env === "production" ? "production" : "staging";
        console.log("Creating backup for " + (options.database || "cloudpress-db") + "...");
        await runCommand("npx", ["wrangler", "d1", "backup", "create", options.database || "cloudpress-db", "--env", env]);
      })
  );

program
  .command("container")
  .description("Container management commands")
  .addCommand(
    new Command("list")
      .description("List containers")
      .option("-e, --env <environment>", "Environment", "staging")
      .option("--subscription <id>", "Filter by subscription")
      .action(async (options) => {
        console.log("Listing containers...");
        const path = "/api/containers" + (options.subscription ? "?subscription=" + options.subscription : "");
        await apiCall("GET", path, options.env);
      })
  )
  .addCommand(
    new Command("logs")
      .description("Get container logs")
      .argument("<containerId>", "Container ID")
      .option("-e, --env <environment>", "Environment", "staging")
      .option("-f, --follow", "Follow logs")
      .action(async (containerId, options) => {
        console.log("Logs for " + containerId + "...");
        await apiCall("GET", "/api/containers/" + containerId + "/logs?follow=" + options.follow, options.env);
      })
  )
  .addCommand(
    new Command("exec")
      .description("Execute command in container")
      .argument("<containerId>", "Container ID")
      .argument("<command...>", "Command to execute")
      .option("-e, --env <environment>", "Environment", "staging")
      .action(async (containerId, command, options) => {
        console.log("Executing in " + containerId + ": " + command.join(" "));
        await apiCall("POST", "/api/containers/" + containerId + "/exec", options.env, { command: command.join(" ") });
      })
  )
  .addCommand(
    new Command("scale")
      .description("Scale container instances")
      .argument("<containerId>", "Container ID")
      .argument("<instances>", "Number of instances")
      .option("-e, --env <environment>", "Environment", "staging")
      .action(async (containerId, instances, options) => {
        console.log("Scaling " + containerId + " to " + instances + " instances...");
        await apiCall("POST", "/api/containers/" + containerId + "/scale", options.env, { instances: parseInt(instances) });
      })
  );

program
  .command("service")
  .description("Service mesh commands")
  .addCommand(
    new Command("list")
      .description("List registered services")
      .option("-n, --namespace <ns>", "Namespace", "default")
      .action(async (options) => {
        console.log("Services in namespace " + options.namespace + ":");
        await apiCall("GET", "/api/mesh/services?namespace=" + options.namespace);
      })
  )
  .addCommand(
    new Command("discover")
      .description("Discover service endpoints")
      .argument("<serviceName>", "Service name")
      .option("-n, --namespace <ns>", "Namespace", "default")
      .action(async (serviceName, options) => {
        console.log("Discovering " + serviceName + "...");
        await apiCall("GET", "/api/mesh/discover/" + serviceName + "?namespace=" + options.namespace);
      })
  )
  .addCommand(
    new Command("policy")
      .description("Manage traffic policies")
      .addCommand(
        new Command("create")
          .description("Create traffic policy")
          .argument("<source>", "Source service")
          .argument("<target>", "Target service")
          .argument("<policy>", "Policy type (allow|deny|rate_limit|retry|timeout|circuit_breaker)")
          .option("-n, --namespace <ns>", "Namespace", "default")
          .option("--config <json>", "Policy configuration JSON", "{}")
          .action(async (source, target, policy, options) => {
            await apiCall("POST", "/api/mesh/policies", "staging", {
              sourceService: source,
              targetService: target,
              namespace: options.namespace,
              policy,
              config: JSON.parse(options.config)
            });
          })
      )
      .addCommand(
        new Command("list")
          .description("List traffic policies")
          .action(async () => {
            await apiCall("GET", "/api/mesh/policies");
          })
      )
  );

program
  .command("domain")
  .description("Domain management commands")
  .addCommand(
    new Command("list")
      .description("List domains")
      .option("-e, --env <environment>", "Environment", "staging")
      .action(async (options) => {
        await apiCall("GET", "/api/domains", options.env);
      })
  )
  .addCommand(
    new Command("register")
      .description("Register new domain")
      .argument("<domain>", "Domain name")
      .option("-e, --env <environment>", "Environment", "staging")
      .option("--registrar <name>", "Registrar to use (cloudflare|gandi|namecheap)")
      .action(async (domain, options) => {
        console.log("Registering " + domain + "...");
        await apiCall("POST", "/api/domains", options.env, {
          hostname: domain,
          registrar: options.registrar || "cloudflare"
        });
      })
  )
  .addCommand(
    new Command("dns")
      .description("Manage DNS records")
      .addCommand(
        new Command("add")
          .description("Add DNS record")
          .argument("<domain>", "Domain name")
          .argument("<type>", "Record type (A|AAAA|CNAME|TXT|MX)")
          .argument("<name>", "Record name")
          .argument("<value>", "Record value")
          .action(async (domain, type, name, value) => {
            await apiCall("POST", "/api/domains/" + domain + "/records", "staging", { type, name, value });
          })
      )
  );

program
  .command("secret")
  .description("Secrets management")
  .addCommand(
    new Command("set")
      .description("Set secret value")
      .argument("<name>", "Secret name")
      .argument("<value>", "Secret value")
      .option("-e, --env <environment>", "Environment", "staging")
      .action(async (name, value, options) => {
        console.log("Setting secret " + name + "...");
        await apiCall("POST", "/api/secrets", options.env, { name, value });
      })
  )
  .addCommand(
    new Command("get")
      .description("Get secret value")
      .argument("<name>", "Secret name")
      .option("-e, --env <environment>", "Environment", "staging")
      .action(async (name, options) => {
        const result = await apiCall("GET", "/api/secrets/" + name, options.env);
        console.log(result.value);
      })
  )
  .addCommand(
    new Command("list")
      .description("List secrets")
      .option("-e, --env <environment>", "Environment", "staging")
      .action(async (options) => {
        await apiCall("GET", "/api/secrets", options.env);
      })
  );

program
  .command("init")
  .description("Initialize new CloudPress project")
  .argument("<name>", "Project name")
  .option("-t, --template <template>", "Template (wordpress|nextjs|laravel|go|python|blank)", "blank")
  .option("--no-git", "Skip git initialization")
  .action(async (name, options) => {
    console.log("Initializing CloudPress project: " + name);
    console.log("Template: " + options.template);
    
    const templates = {
      wordpress: "https://github.com/cloudpress/templates-wordpress",
      nextjs: "https://github.com/cloudpress/templates-nextjs",
      laravel: "https://github.com/cloudpress/templates-laravel",
      go: "https://github.com/cloudpress/templates-go",
      python: "https://github.com/cloudpress/templates-python",
      blank: "https://github.com/cloudpress/templates-blank"
    };

    await runCommand("git", ["clone", templates[options.template as keyof typeof templates] || templates.blank, name]);
    
    if (!options.git) {
      await runCommand("rm", ["-rf", join(name, ".git")]);
    }
    
    console.log("Project created: " + name);
    console.log("cd " + name);
    console.log("cloudpress deploy --env staging");
  });

program
  .command("status")
  .description("Show platform status")
  .option("-e, --env <environment>", "Environment", "staging")
  .action(async (options) => {
    console.log("CloudPress Platform Status");
    console.log("============================");
    await apiCall("GET", "/api/health", options.env);
    await apiCall("GET", "/api/status", options.env);
  });

async function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: true });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Command failed with code " + code));
    });
    child.on("error", reject);
  });
}

async function apiCall(method: string, path: string, env: string, body?: any): Promise<any> {
  const baseUrl = env === "production" 
    ? "https://cloud-press.co.kr" 
    : "https://staging.cloud-press.co.kr";
  
  const res = await fetch(baseUrl + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
  return data;
}

program.parse(process.argv);
