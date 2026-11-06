import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  UPDATE_FEED_MISSING,
  type AppUpdateState,
} from "../src/shared/desktop/app-update.js";
import {
  DesktopAppUpdater,
  type UpdateClock,
  type UpdateFeedClient,
  type UpdateFeedHandlers,
} from "../src/desktop/updates/app-updater.js";
import { performUpdateInstall } from "../src/desktop/updates/update-install.js";
import {
  loadUpdateRuntime,
  normalizeGenericFeedUrl,
  resolveDefaultUpdateChannel,
  resolveUpdateAvailability,
  shouldDisableDifferentialDownload,
  UPDATE_DISABLED_ENV,
  UPDATE_FEED_BAD_URL,
  UPDATE_FEED_UNSUPPORTED,
  UPDATE_FEED_UNREADABLE,
  UPDATE_LINUX_PACKAGE,
  UPDATE_UNPACKAGED,
  type UpdateRuntime,
} from "../src/desktop/updates/update-feed.js";

const packaged = {
  ymlRaw: null as string | null,
  ymlUnreadable: false,
  envUrl: "https://files.example/aster",
  isPackaged: true,
  forceDevUpdate: false,
  disabledByEnv: false,
  platform: "linux",
  appImage: "/tmp/Aster.AppImage",
  isDebPackage: false,
};

await test("generic feed accepts rustfs https and local http, and rejects the rest", () => {
  assert.equal(
    normalizeGenericFeedUrl("https://files.example/aster"),
    "https://files.example/aster/",
  );
  assert.equal(
    normalizeGenericFeedUrl("http://127.0.0.1:9000/aster"),
    "http://127.0.0.1:9000/aster/",
  );
  assert.equal(
    normalizeGenericFeedUrl("http://localhost:9000/aster/"),
    "http://localhost:9000/aster/",
  );
  assert.equal(normalizeGenericFeedUrl("http://10.0.0.8/aster"), null);
  assert.equal(
    normalizeGenericFeedUrl("https://user:secret@files.example/a"),
    null,
  );
  assert.equal(
    normalizeGenericFeedUrl("https://files.example/a?token=1"),
    null,
  );
  assert.equal(normalizeGenericFeedUrl("https://files.example/a#part"), null);
});

await test("packaged GitHub and generic feeds win over the environment", () => {
  const quoted = resolveUpdateAvailability({
    ...packaged,
    ymlRaw:
      '# comment\r\nprovider: "generic"\r\nurl: "https://rustfs.example/app"\r\n',
    envUrl: "https://other.example/app",
  });
  assert.deepEqual(quoted.feed, {
    provider: "generic",
    url: "https://rustfs.example/app/",
    useMultipleRangeRequest: false,
  });
  assert.equal(quoted.disabledReason, null);
  const github = resolveUpdateAvailability({
    ...packaged,
    ymlRaw: "provider: github\nowner: scopevar\nrepo: aster\n",
    envUrl: "https://files.example/aster",
  });
  assert.deepEqual(github.feed, {
    provider: "github",
    owner: "scopevar",
    repo: "aster",
  });
  assert.equal(github.disabledReason, null);
  for (const manifest of [
    "provider: github\nowner: scopevar\n",
    "provider: github\nowner: ../scopevar\nrepo: aster\n",
  ])
    assert.equal(
      resolveUpdateAvailability({ ...packaged, ymlRaw: manifest })
        .disabledReason,
      UPDATE_FEED_BAD_URL,
    );
  assert.equal(
    resolveUpdateAvailability({ ...packaged, ymlRaw: "provider: s3\n" })
      .disabledReason,
    UPDATE_FEED_UNSUPPORTED,
  );
  assert.deepEqual(
    resolveUpdateAvailability({ ...packaged, envUrl: "   " }).disabledReason,
    UPDATE_FEED_MISSING,
  );
  assert.equal(
    resolveUpdateAvailability({
      ...packaged,
      ymlRaw: null,
      envUrl: "http://10.0.0.8/aster",
    }).disabledReason,
    UPDATE_FEED_BAD_URL,
  );
  assert.equal(
    resolveUpdateAvailability({ ...packaged, ymlUnreadable: true })
      .disabledReason,
    UPDATE_FEED_UNREADABLE,
  );
});

await test("update manifests accept YAML comments, quoted values and extra updater metadata", () => {
  for (const ymlRaw of [
    'provider: "generic" # provider\nurl: "https://files.example/aster/" # feed\nupdaterCacheDirName: aster-updater\n',
    '{ provider: generic, url: "https://files.example/aster/" }',
  ]) {
    const result = resolveUpdateAvailability({ ...packaged, ymlRaw });
    assert.equal(result.disabledReason, null);
    assert.deepEqual(result.feed, {
      provider: "generic",
      url: "https://files.example/aster/",
      useMultipleRangeRequest: false,
    });
  }
});

await test("invalid YAML or manifest fields disable updates without falling back to the environment", () => {
  for (const ymlRaw of [
    "provider: [generic",
    "provider: generic\nprovider: github\n",
    "- provider: generic\n",
    "provider: generic\nurl: 123\n",
    "null",
  ]) {
    assert.deepEqual(resolveUpdateAvailability({ ...packaged, ymlRaw }), {
      feed: null,
      disabledReason: UPDATE_FEED_UNREADABLE,
    });
  }
});

await test("availability is disabled in order after a usable feed is found", () => {
  assert.equal(
    resolveUpdateAvailability({
      ...packaged,
      isPackaged: false,
      appImage: null,
    }).disabledReason,
    UPDATE_UNPACKAGED,
  );
  assert.equal(
    resolveUpdateAvailability({ ...packaged, disabledByEnv: true })
      .disabledReason,
    UPDATE_DISABLED_ENV,
  );
  assert.equal(
    resolveUpdateAvailability({ ...packaged, appImage: null }).disabledReason,
    UPDATE_LINUX_PACKAGE,
  );
  assert.deepEqual(
    resolveUpdateAvailability({
      ...packaged,
      appImage: null,
      isDebPackage: true,
    }).feed,
    {
      provider: "generic",
      url: "https://files.example/aster/",
      useMultipleRangeRequest: false,
    },
  );
  assert.equal(
    resolveDefaultUpdateChannel("0.1.0-nightly.20261013.3"),
    "nightly",
  );
  assert.equal(resolveDefaultUpdateChannel("0.1.0"), "latest");
  assert.equal(shouldDisableDifferentialDownload("aarch64", "x64"), true);
  assert.equal(shouldDisableDifferentialDownload("arm64", "x64"), true);
  assert.equal(shouldDisableDifferentialDownload("arm64", "arm64"), false);
  assert.equal(shouldDisableDifferentialDownload("x64", "x64"), false);
});

await test("loadUpdateRuntime reads the packaged manifest and deb marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-update-feed-"));
  try {
    await writeFile(
      join(directory, "app-update.yml"),
      "provider: generic\nurl: https://rustfs.example/desktop\n",
    );
    await writeFile(join(directory, "package-type"), " deb \n");
    const runtime = loadUpdateRuntime({
      currentVersion: "0.1.0",
      isPackaged: true,
      appPath: join(directory, "missing-app"),
      resourcesPath: directory,
      platform: "linux",
      appArch: "x64",
      hostArch: "aarch64",
      appImage: undefined,
      disabledByEnv: false,
      forceDevUpdate: false,
      envUrl: "https://ignored.example/app",
      channel: "latest",
      autoUpdate: false,
    });
    assert.deepEqual(runtime.feed, {
      provider: "generic",
      url: "https://rustfs.example/desktop/",
      useMultipleRangeRequest: false,
    });
    assert.equal(runtime.disabledReason, null);
    assert.equal(runtime.disableDifferentialDownload, true);
    assert.equal(runtime.forceDevUpdateConfig, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("an unreadable manifest disables updates before the environment url", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-update-unreadable-"));
  const blocked = join(directory, "resources");
  try {
    await mkdir(join(blocked, "app-update.yml"), { recursive: true });
    const runtime = loadUpdateRuntime({
      currentVersion: "0.1.0",
      isPackaged: true,
      appPath: directory,
      resourcesPath: blocked,
      platform: "linux",
      appArch: "x64",
      hostArch: "x64",
      appImage: "/tmp/Aster.AppImage",
      disabledByEnv: false,
      forceDevUpdate: false,
      envUrl: "https://files.example/aster",
      channel: "latest",
      autoUpdate: true,
    });
    assert.equal(runtime.feed, null);
    assert.equal(runtime.disabledReason, UPDATE_FEED_UNREADABLE);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class FakeClock implements UpdateClock {
  readonly timers: {
    ms: number;
    kind: "timeout" | "interval";
    run: () => void;
  }[] = [];
  setTimeout(run: () => void, ms: number) {
    const timer = { ms, kind: "timeout" as const, run, cleared: false };
    this.timers.push(timer);
    return { clear: () => void (timer.cleared = true) };
  }
  setInterval(run: () => void, ms: number) {
    const timer = { ms, kind: "interval" as const, run, cleared: false };
    this.timers.push(timer);
    return { clear: () => void (timer.cleared = true) };
  }
}

class FakeClient implements UpdateFeedClient {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  channel: string | null = null;
  allowPrerelease = false;
  allowDowngrade = false;
  fullChangelog = false;
  disableDifferentialDownload = false;
  forceDevUpdateConfig = false;
  feed: Parameters<UpdateFeedClient["setFeedURL"]>[0] | null = null;
  handlers: UpdateFeedHandlers | null = null;
  checks: boolean[] = [];
  downloads = 0;
  installs: { silent: boolean; force: boolean }[] = [];
  setFeedURL(options: Parameters<UpdateFeedClient["setFeedURL"]>[0]) {
    this.feed = options;
  }
  async checkForUpdates() {
    this.checks.push(this.allowDowngrade);
    this.handlers?.available("0.2.0");
  }
  async downloadUpdate() {
    this.downloads += 1;
    this.handlers?.progress(0);
    this.handlers?.progress(9);
    this.handlers?.progress(10);
    this.handlers?.progress(25);
    this.handlers?.progress(100);
    this.handlers?.downloaded("0.2.0");
  }
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean) {
    this.installs.push({ silent: isSilent, force: isForceRunAfter });
  }
  bind(handlers: UpdateFeedHandlers) {
    this.handlers = handlers;
    return () => {
      this.handlers = null;
    };
  }
}

function enabledRuntime(patch: Partial<UpdateRuntime> = {}): UpdateRuntime {
  return {
    currentVersion: "0.1.0",
    feed: {
      provider: "generic",
      url: "https://rustfs.example/aster/",
      useMultipleRangeRequest: false,
    },
    disabledReason: null,
    channel: "latest",
    autoUpdate: false,
    disableDifferentialDownload: true,
    forceDevUpdateConfig: true,
    ...patch,
  };
}

await test("updater checks, ignores the other channel, and reports download milestones", async () => {
  const client = new FakeClient();
  const clock = new FakeClock();
  const updater = new DesktopAppUpdater(
    enabledRuntime({ autoUpdate: true }),
    () => client,
    clock,
  );
  const progress: number[] = [];
  updater.subscribe((state) => {
    if (state.status === "downloading" && state.downloadPercent !== null)
      progress.push(state.downloadPercent);
  });
  updater.start();
  assert.equal(client.autoDownload, false);
  assert.equal(client.autoInstallOnAppQuit, false);
  assert.equal(client.forceDevUpdateConfig, true);
  assert.equal(client.disableDifferentialDownload, true);
  assert.deepEqual(client.feed, {
    provider: "generic",
    url: "https://rustfs.example/aster/",
    useMultipleRangeRequest: false,
  });
  assert.deepEqual(
    clock.timers.map((timer) => timer.ms),
    [15_000, 240_000],
  );
  const checked = await updater.check();
  assert.equal(checked.status, "available");
  assert.equal(checked.availableVersion, "0.2.0");
  client.handlers?.available("0.2.0-nightly.20261013.1");
  assert.equal(updater.getState().status, "up-to-date");
  assert.equal(updater.getState().availableVersion, null);
  client.handlers?.available("0.2.0");
  const downloaded = await updater.download();
  assert.deepEqual(progress, [0, 10, 20, 100]);
  assert.equal(downloaded.status, "downloaded");
  assert.equal(downloaded.downloadedVersion, "0.2.0");
  assert.equal(updater.getState().downloadPercent, 100);
  updater.beginInstall();
  updater.finishInstall();
  assert.deepEqual(client.installs, [{ silent: true, force: true }]);
});

await test("a newer release replaces the previous download and remains downloadable", async () => {
  const client = new FakeClient();
  const updater = new DesktopAppUpdater(enabledRuntime(), () => client);
  updater.start();
  try {
    await updater.check();
    await updater.download();
    client.checkForUpdates = async () => {
      client.handlers?.available("0.3.0");
    };
    client.downloadUpdate = async () => {
      client.handlers?.downloaded("0.3.0");
    };
    await updater.check();
    assert.equal(updater.getState().downloadedVersion, null);
    assert.equal((await updater.download()).downloadedVersion, "0.3.0");
    updater.beginInstall();
    updater.finishInstall();
    assert.equal(client.installs.length, 1);
  } finally {
    updater.stop();
  }
});

await test("a held update action blocks the next action and the poller", async () => {
  const client = new FakeClient();
  const gate: { release: (() => void) | null } = { release: null };
  client.checkForUpdates = async () => {
    client.checks.push(client.allowDowngrade);
    await new Promise<void>((resolve) => {
      gate.release = resolve;
    });
  };
  const clock = new FakeClock();
  const updater = new DesktopAppUpdater(
    enabledRuntime({ autoUpdate: true }),
    () => client,
    clock,
  );
  updater.start();
  const pending = updater.check();
  await assert.rejects(updater.download(), /已有更新操作正在进行/);
  clock.timers[1]?.run();
  assert.equal(client.checks.length, 1);
  gate.release?.();
  await pending;
});

await test("channel changes route feeds independently and never downgrade", async () => {
  const client = new FakeClient();
  client.checkForUpdates = async () => {
    client.checks.push(client.allowDowngrade);
  };
  const updater = new DesktopAppUpdater(
    enabledRuntime({
      channel: "nightly",
      currentVersion: "0.2.0-nightly.20261013.3",
      feed: {
        provider: "generic",
        url: "https://dl.example/updates/stable/",
        useMultipleRangeRequest: false,
      },
      disableDifferentialDownload: false,
    }),
    () => client,
  );
  updater.start();
  assert.deepEqual(client.feed, {
    provider: "generic",
    url: "https://dl.example/updates/nightly/",
    useMultipleRangeRequest: false,
  });
  assert.equal(client.disableDifferentialDownload, false);
  client.handlers?.available("0.2.0-nightly.20261013.2");
  assert.equal(updater.getState().availableVersion, null);
  client.handlers?.available("0.2.0-nightly.20261013.4");
  assert.equal(updater.getState().availableVersion, "0.2.0-nightly.20261013.4");
  updater.applyPreferences({ updateChannel: "latest", autoUpdate: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.getState().channel, "latest");
  assert.equal(updater.getState().availableVersion, null);
  assert.equal(updater.getState().downloadedVersion, null);
  assert.deepEqual(client.checks, [false]);
  assert.equal(client.allowDowngrade, false);
  assert.equal(client.channel, "latest");
  assert.deepEqual(client.feed, {
    provider: "generic",
    url: "https://dl.example/updates/stable/",
    useMultipleRangeRequest: false,
  });
  assert.equal(client.disableDifferentialDownload, true);
  client.handlers?.available("0.1.9");
  assert.equal(updater.getState().availableVersion, null);
  client.handlers?.available("0.2.0");
  assert.equal(updater.getState().availableVersion, "0.2.0");
  client.handlers?.available("0.3.0-nightly.20260230.1");
  assert.equal(updater.getState().availableVersion, null);
  updater.stop();
});

await test("disabled feeds and a failed client never keep a usable updater", async () => {
  let created = 0;
  const disabled = new DesktopAppUpdater(
    enabledRuntime({ feed: null, disabledReason: UPDATE_FEED_MISSING }),
    () => {
      created += 1;
      return new FakeClient();
    },
  );
  disabled.start();
  assert.equal(created, 0);
  assert.equal(disabled.getState().enabled, false);
  await assert.rejects(disabled.check(), /更新源尚未配置/);
  const broken = new DesktopAppUpdater(enabledRuntime(), () => {
    throw new Error("module missing at /tmp/secret");
  });
  broken.start();
  assert.equal(broken.getState().disabledReason, "更新组件未能加载。");
  assert.equal(broken.getState().message, null);
});

await test("install releases the single-instance lock only after the worker stops", async () => {
  let quitting = false;
  let held = true;
  const calls: string[] = [];
  const updates: {
    beginInstall(): void;
    cancelInstall(): void;
    finishInstall(): AppUpdateState;
  } = {
    beginInstall() {
      calls.push("begin");
    },
    cancelInstall() {
      calls.push("cancel");
    },
    finishInstall() {
      calls.push("finish");
      return {
        enabled: true,
        status: "downloaded" as const,
        channel: "latest" as const,
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        downloadedVersion: "0.2.0",
        downloadPercent: 100,
        message: null,
        disabledReason: null,
      };
    },
  };
  await performUpdateInstall({
    updates,
    stopWorker: async () => {
      calls.push("stop");
    },
    held: () => held,
    release: () => {
      calls.push("release");
      held = false;
    },
    request: () => {
      calls.push("request");
      held = true;
    },
    setQuitting: (value) => {
      quitting = value;
    },
  });
  assert.deepEqual(calls, ["begin", "stop", "release", "finish"]);
  assert.equal(quitting, true);
  await assert.rejects(
    performUpdateInstall({
      updates: {
        ...updates,
        beginInstall() {
          calls.push("begin-fail");
        },
      },
      stopWorker: async () => {
        throw new Error("ENOENT /tmp/worker");
      },
      held: () => held,
      release: () => calls.push("release-fail"),
      request: () => calls.push("request-fail"),
      setQuitting: () => calls.push("quit-fail"),
    }),
    /更新前未能停止后台/,
  );
  assert.equal(calls.includes("release-fail"), false);
  updates.finishInstall = () => ({
    enabled: true,
    status: "error" as const,
    channel: "latest" as const,
    currentVersion: "0.1.0",
    availableVersion: "0.2.0",
    downloadedVersion: "0.2.0",
    downloadPercent: 100,
    message: "安装更新失败。",
    disabledReason: null,
  });
  // The previous success left the lock released. Restore it for the failure path.
  held = true;
  const failed = await performUpdateInstall({
    updates,
    stopWorker: async () => undefined,
    held: () => held,
    release: () => {
      held = false;
    },
    request: () => {
      held = true;
    },
    setQuitting: (value) => {
      quitting = value;
    },
  });
  assert.equal(failed.status, "error");
  assert.equal(quitting, false);
  assert.equal(held, true);
});
