import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AppError } from "../shared/core.js";
import type {
  SandboxNetworkConfiguration,
  SandboxNetworkTest,
} from "../shared/tools/sandbox-settings.js";
import { SandboxProcess } from "./process.js";
import type { SandboxResources } from "./resources.js";

const check = z
  .object({
    stage: z.enum(["dns", "https"]),
    state: z.enum(["passed", "failed"]),
    detail: z.string().max(1000),
  })
  .strict();
const exec = promisify(execFile);

async function resolveSystemDns(hostname: string, signal: AbortSignal) {
  // OS lookup matches normal applications. A short-lived helper makes it cancellable.
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"])
    if (process.env[key]) env[key] = process.env[key];
  const { stdout } = await exec(
    process.execPath,
    [
      "-e",
      "require('node:dns').lookup(process.argv[1],{all:true},(e,a)=>{if(e)process.exit(1);console.log(JSON.stringify(a.map(v=>v.address)))})",
      hostname,
    ],
    { env, signal, timeout: 4000, maxBuffer: 4096, windowsHide: true },
  );
  return z
    .array(z.union([z.ipv4(), z.ipv6()]))
    .max(16)
    .parse(JSON.parse(stdout));
}

/** A UI-owned diagnostic uses empty mounts and an explicit target, never a Bot's data. */
export class SandboxNetworkDiagnostics {
  state: SandboxNetworkTest | null = null;
  private controller: AbortController | undefined;
  private task: Promise<void> | undefined;
  private busy = false;
  private fingerprint = "";
  private cleanupFailure: unknown;
  constructor(
    private readonly directory: string,
    private readonly resources: SandboxResources,
    private readonly systemDns = resolveSystemDns,
  ) {}
  get running() {
    return this.busy;
  }

  start(
    id: string,
    hostname: string,
    configuration: SandboxNetworkConfiguration,
  ) {
    const fingerprint = JSON.stringify({ hostname, configuration });
    if (this.state?.id === id) {
      if (fingerprint !== this.fingerprint)
        throw new AppError("conflict", "同一次网络诊断不能更改配置。");
      return;
    }
    if (this.running) throw new AppError("capacity", "已有网络诊断正在运行。");
    this.fingerprint = fingerprint;
    this.cleanupFailure = undefined;
    const controller = new AbortController();
    this.controller = controller;
    const state: SandboxNetworkTest = {
      id,
      hostname,
      state: "running",
      detail: "正在准备沙箱网络诊断…",
      systemAddresses: [],
      dns: { state: "pending", detail: "等待检查" },
      https: { state: "pending", detail: "等待检查" },
    };
    this.state = state;
    this.busy = true;
    this.task = this.run(state, configuration, controller.signal)
      .then((success) => {
        state.state = success ? "passed" : "failed";
      })
      .catch((error: unknown) => {
        state.state =
          controller.signal.aborted && !this.cleanupFailure
            ? "cancelled"
            : "failed";
        state.detail =
          state.state === "cancelled"
            ? "已停止网络诊断。"
            : error instanceof Error
              ? error.message.slice(0, 1000)
              : "网络诊断失败。";
      })
      .finally(() => {
        this.busy = false;
      });
  }
  private async run(
    state: SandboxNetworkTest,
    configuration: SandboxNetworkConfiguration,
    signal: AbortSignal,
  ) {
    try {
      state.systemAddresses = await this.systemDns(state.hostname, signal);
    } catch {
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    const root = join(this.directory, "network-tests", state.id);
    const vm = new SandboxProcess(signal, (detail) => {
      state.detail = detail;
    });
    try {
      await this.resources.wait(signal, (detail) => {
        state.detail = detail;
      });
      const workspace = join(root, "workspace"),
        inputs = join(root, "inputs");
      await mkdir(workspace, { recursive: true });
      await mkdir(inputs, { recursive: true });
      await vm.open({
        home: join(this.directory, "runtime"),
        assets: join(this.directory, "assets"),
        workspace,
        inputs,
        name: `aster-script-${state.id}`,
        quotaMiB: 512,
        network: [state.hostname],
        configuration,
      });
      state.detail = "正在沙箱内检查 DNS 和 HTTPS…";
      const result = await vm.execute(`python3 -u - <<'PY'
import json, socket, urllib.request, sys
host = ${JSON.stringify(state.hostname)}
stage = 'dns'
try:
    addresses = sorted({r[4][0] for r in socket.getaddrinfo(host, 443)})
    print(json.dumps({'stage': stage, 'state': 'passed', 'detail': ', '.join(addresses)}), flush=True)
    stage = 'https'
    with urllib.request.urlopen('https://' + host + '/', timeout=15) as response:
        response.read(1)
        print(json.dumps({'stage': stage, 'state': 'passed', 'detail': 'HTTP ' + str(response.status)}), flush=True)
except Exception as error:
    print(json.dumps({'stage': stage, 'state': 'failed', 'detail': str(error)[:800]}), flush=True)
    sys.exit(1)
PY`);
      for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
        const value = check.parse(JSON.parse(line));
        state[value.stage] = { state: value.state, detail: value.detail };
      }
      if (state.dns.state === "failed" && result.stderr)
        state.dns.detail = `${state.dns.detail}；${result.stderr}`.slice(
          0,
          1000,
        );
      const success =
        result.exitCode === 0 &&
        state.dns.state === "passed" &&
        state.https.state === "passed";
      state.detail = success
        ? "沙箱内 DNS 解析和 HTTPS 请求均已通过。"
        : state.dns.state === "failed" &&
            configuration.dns.mode !== "auto" &&
            state.systemAddresses.some((address) =>
              /^198\.(18|19)\./.test(address),
            )
          ? "检测到系统 DNS 返回 Fake-IP，沙箱无法解析目标域名；请选择自动解析后重试。"
          : (state.https.state === "failed"
              ? state.https.detail
              : state.dns.state === "failed"
                ? state.dns.detail
                : result.stderr.slice(0, 1000)) || "沙箱未返回完整诊断结果。";
      return success;
    } finally {
      try {
        await vm.close();
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        this.cleanupFailure = error;
        throw error;
      }
    }
  }
  async cancel(id: string) {
    if (this.state?.id !== id) return;
    this.controller?.abort();
    await this.task;
    if (this.cleanupFailure) throw this.cleanupFailure;
  }
  async stop() {
    if (this.state) await this.cancel(this.state.id);
  }
}
