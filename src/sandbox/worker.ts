import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Sandbox, CreationProgressCreate, DnsBuilder } from "microsandbox";
import { loadScriptAssets } from "./assets.js";
import {
  configureScriptRuntime,
  prepareScriptResources,
} from "./preparation.js";
import { scriptImage } from "./assets-manifest.js";
import { pythonPackages } from "./python-assets.js";
import {
  sandboxInputSchema,
  sandboxLimits,
  type SandboxLaunch,
} from "./protocol.js";
import type { ScriptExecution } from "../shared/tools/scripts.js";
import { drainScriptProcesses } from "./guest-processes.js";
import { SandboxDns } from "./dns.js";
import { defaultSandboxNetworkConfiguration } from "../shared/tools/sandbox-settings.js";
import { resolvePublicDns } from "../network/web-policy.js";
import { openDnsProxy } from "./dns-proxy.js";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const controller = new AbortController();
const send = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
let vm: Sandbox | undefined;
let creation: CreationProgressCreate | undefined;
let opening: Promise<void> | undefined;
let command: Promise<void> | undefined;
let closing: Promise<void> | undefined;
let destruction: Promise<void> | undefined;
let dns: SandboxDns | undefined;
let dnsProxy: Awaited<ReturnType<typeof openDnsProxy>> | undefined;
const detail = (error: unknown) =>
  error instanceof Error
    ? error.message.slice(0, 1000)
    : "Microsandbox 执行失败。";

async function open(config: SandboxLaunch) {
  const status = (text: string) => {
    send({ type: "status", detail: text });
  };
  const assets = await loadScriptAssets(config.assets);
  controller.signal.throwIfAborted();
  await configureScriptRuntime(config, assets);
  const sdk = await import("microsandbox");
  sdk.setDefaultBackend("local");
  const configuration =
    config.configuration ?? defaultSandboxNetworkConfiguration();
  let nameservers: string[] = [];
  if (config.network.length && configuration.dns.mode === "auto") {
    if (configuration.proxy) dnsProxy = await openDnsProxy(configuration.proxy);
    dns = new SandboxDns(config.network, (hostname, signal) =>
      resolvePublicDns(hostname, signal, dnsProxy?.request),
    );
    nameservers = [await dns.open()];
  } else if (configuration.dns.mode === "custom") {
    nameservers = configuration.dns.servers;
  }
  const policy = {
    ...sdk.NetworkPolicy.none(),
    rules: config.network.length
      ? [
          sdk.Rule.allowDns(),
          ...config.network.map((host) => ({
            direction: "egress" as const,
            destination: sdk.Destination.domain(host),
            protocols: ["tcp" as const],
            ports: [sdk.PortRange.single(443)],
            action: "allow" as const,
          })),
        ]
      : [],
  };
  let builder = sdk.Sandbox.builder(config.name)
    .image(scriptImage)
    .cpus(sandboxLimits.cpus)
    .memory(sandboxLimits.memoryMiB)
    .rootDisk(sandboxLimits.rootMiB)
    .security("restricted")
    .user("1000:1000")
    .workdir("/workspace")
    .env("HOME", "/workspace")
    .rlimit("nproc", 128)
    .rlimit("nofile", 256)
    .maxDuration(660)
    .volume("/workspace", (b) =>
      b
        .bind(config.workspace)
        .owner(1000, 1000)
        .quota(config.quotaMiB)
        .nosuid()
        .nodev(),
    )
    .volume("/inputs", (b) =>
      b.bind(config.inputs).readonly().noexec().nosuid().nodev(),
    )
    .env("PYTHONPATH", "/opt/aster-python")
    .env("NODE_USE_SYSTEM_CA", "1")
    .patch((b) => {
      b.copyFile(assets.node, "/usr/local/bin/node", { mode: 0o755 });
      b.mkdir("/opt/aster-python", { mode: 0o777 });
      for (const asset of pythonPackages(
        process.arch === "arm64" ? "arm64" : "x64",
      ))
        b.copyFile(
          join(config.assets, asset.file),
          `/opt/aster-wheels/${asset.file}`,
          { mode: 0o644 },
        );
      return b;
    });
  builder = config.network.length
    ? builder.network((b) =>
        b
          .policy(policy)
          .dns((d: InstanceType<typeof DnsBuilder>) =>
            d
              .nameservers(nameservers)
              .rebindProtection(true)
              .queryTimeoutMs(8000),
          )
          .strict(true)
          .maxTcpConnections(32)
          .maxUdpConnections(32),
      )
    : builder.disableNetwork();
  if (config.network.length) {
    // Strict hostname rules require HTTPS inspection; upstream verification stays enabled.
    builder = builder.interceptTls();
    const proxy = configuration.proxy;
    if (proxy)
      builder = builder.proxy((p) =>
        proxy.protocol === "http"
          ? p.httpConnect(proxy.address)
          : p.socks5(proxy.address),
      );
  }
  status(
    "固定资源已就绪，正在启动微型虚拟机；启动上限为两分钟，脚本尚未执行。",
  );
  const pending = await builder.createWithProgress();
  creation = pending;
  const cancel = () => creation?.cancel();
  controller.signal.addEventListener("abort", cancel, { once: true });
  if (controller.signal.aborted) cancel();
  try {
    vm = await pending.awaitSandbox();
  } finally {
    controller.signal.removeEventListener("abort", cancel);
    creation = undefined;
  }
  controller.signal.throwIfAborted();
  status("正在离线准备 Python 文档处理库；用户命令尚未执行。");
  const prepared = await vm.execWith("python3", (b) =>
    b.args([
      "-I",
      "-c",
      "import glob,zipfile; [zipfile.ZipFile(p).extractall('/opt/aster-python') for p in glob.glob('/opt/aster-wheels/*.whl')]",
    ]),
  );
  if (!prepared.success)
    throw new Error(`Python 文档环境准备失败：${prepared.stderr}`);
  controller.signal.throwIfAborted();
  send({ type: "ready" });
}
function destroy(): Promise<void> {
  if (destruction) return destruction;
  if (!vm) return Promise.resolve();
  const target = vm;
  vm = undefined;
  destruction = target.destroy({
    force: true,
    timeoutMs: sandboxLimits.stopMs,
  });
  return destruction;
}
async function execute(text: string) {
  if (!vm || closing) throw new Error("脚本沙箱未就绪。");
  const start = performance.now();
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let outBytes = 0,
    errBytes = 0,
    truncated = false,
    code: number | null = null;
  const decoderOut = new TextDecoder(),
    decoderErr = new TextDecoder();
  let result: ScriptExecution;
  let timedOut = false;
  // 0.7.11's streaming handle does not enforce the collect() timeout path.
  // This owner retires the VM at the application deadline, including setsid children.
  const timer = setTimeout(() => {
    timedOut = true;
    void destroy().catch(() => {});
  }, sandboxLimits.commandMs);
  try {
    const handle = await vm.execStreamWith("/bin/bash", (b) =>
      b
        .args(["--noprofile", "--norc", "-c", text])
        .timeout(sandboxLimits.commandMs),
    );
    for await (const event of handle) {
      if (event.kind === "exited") {
        code = event.code;
        continue;
      }
      if (event.kind !== "stdout" && event.kind !== "stderr") continue;
      const count = event.kind === "stdout" ? outBytes : errBytes;
      const bytes = Buffer.from(
        event.data.subarray(0, Math.max(0, sandboxLimits.outputBytes - count)),
      );
      if (bytes.length < event.data.length) truncated = true;
      if (!bytes.length) continue;
      if (event.kind === "stdout") {
        stdout.push(bytes);
        outBytes += bytes.length;
      } else {
        stderr.push(bytes);
        errBytes += bytes.length;
      }
    }
    if (timedOut)
      throw new Error(`脚本执行超时（${sandboxLimits.commandMs}ms）。`);
    if (code === null)
      throw new Error("Microsandbox 没有返回退出码；请核实工作文件后再执行。");
    await drainScriptProcesses(vm);
    result = {
      status: code === 0 ? "completed" : "failed",
      stdout: decoderOut.decode(Buffer.concat(stdout)),
      stderr: decoderErr.decode(Buffer.concat(stderr)),
      exitCode: code,
      truncated,
      durationMs: performance.now() - start,
    };
  } catch (error) {
    // A session/process-group kill cannot contain a child that calls setsid(). Retire the VM.
    await destroy();
    result = {
      status: controller.signal.aborted ? "cancelled" : "failed",
      stdout: decoderOut.decode(Buffer.concat(stdout)),
      stderr:
        `${decoderErr.decode(Buffer.concat(stderr))}\n${timedOut ? `脚本执行超时（${sandboxLimits.commandMs}ms），已销毁所属虚拟机。` : detail(error)}`.slice(
          0,
          65536,
        ),
      exitCode: null,
      truncated,
      durationMs: performance.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
  if (dns?.error)
    result.stderr = `${result.stderr}\n加密 DNS：${dns.error}`.slice(0, 65536);
  if (!closing) send({ type: "result", result });
}
function close() {
  return (closing ??= (async () => {
    controller.abort();
    creation?.cancel();
    await opening?.catch(() => {});
    try {
      await destroy();
      await command;
    } finally {
      try {
        await dns?.close();
      } finally {
        await dnsProxy?.close();
      }
    }
    send({ type: "closed" });
    input.close();
    process.stdin.destroy();
  })().catch((error: unknown) => {
    send({ type: "error", detail: `沙箱清理未能确认：${detail(error)}` });
    process.exitCode = 1;
    input.close();
    process.stdin.destroy();
  }));
}
input.on("line", (line) => {
  try {
    if (Buffer.byteLength(line) > 256 * 1024) throw new Error("沙箱请求过大。");
    const value = sandboxInputSchema.parse(JSON.parse(line));
    if (value.type === "close") {
      void close();
      return;
    }
    if (closing) throw new Error("沙箱正在停止。");
    if (value.type === "open" || value.type === "prepare") {
      if (opening) throw new Error("沙箱不能重复初始化。");
      opening =
        value.type === "prepare"
          ? prepareScriptResources(value.config, controller.signal, (detail) =>
              send({ type: "status", detail }),
            ).then(() => {
              send({ type: "prepared" });
            })
          : open(value.config);
      void opening.catch((error: unknown) => {
        send({ type: "error", detail: detail(error) });
        void close();
      });
    } else {
      if (!vm || command) throw new Error("沙箱未就绪或存在并发命令。");
      command = execute(value.command)
        .catch((error: unknown) => {
          send({ type: "error", detail: detail(error) });
          void close();
        })
        .finally(() => {
          command = undefined;
        });
    }
  } catch (error) {
    send({ type: "error", detail: detail(error) });
    void close();
  }
});
input.on("close", () => {
  void close();
});
process.once("SIGTERM", () => {
  void close();
});
