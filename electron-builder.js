import { stageDaemonRuntime } from "./scripts/stage-daemon-runtime.mjs";
const feedUrl = process.env.ASTER_UPDATE_URL?.trim();
const channel = process.env.ASTER_RELEASE_CHANNEL?.trim() || "latest";
const repository = (
  process.env.ASTER_UPDATE_REPOSITORY ||
  process.env.GITHUB_REPOSITORY ||
  ""
).trim();
if (
  repository &&
  !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)
)
  throw new Error("更新仓库必须使用 owner/repo 格式。");

// Desktop and its detached daemon share the Electron executable.
/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "com.scopevar.aster",
  productName: "Aster",
  artifactName: "aster-${version}-${arch}.${ext}",
  directories: { output: "release" },
  npmRebuild: true,
  asar: true,
  electronLanguages: ["en-US", "zh-CN"],
  publish: null,
  beforePack: stageDaemonRuntime,
  extraResources: [
    { from: "build/daemon-runtime", to: "daemon-runtime" },
    { from: "packages/cli/dist/licenses", to: "licenses" },
  ],
  // CLI 包的子线程、MCP 与原生依赖必须使用真实文件路径。
  asarUnpack: ["node_modules/**/*"],
  files: [
    "dist/desktop/**/*",
    "dist/renderer/**/*",
    "dist/package.json",
    "package.json",
    "assets/**/*",
    "!**/*.map",
    "!**/*.md",
    "!**/demo/**",
    "!**/docs/**",
    "!**/examples/**",
    // 这些包已由 esbuild 打进 dist，运行时不再从 node_modules 加载。
    "!node_modules/mermaid/**",
    "!node_modules/@mermaid-js/parser/**",
    "!node_modules/cytoscape/**",
    "!node_modules/cytoscape-fcose/**",
    "!node_modules/katex/**",
    "!node_modules/emojibase-data/**",
    "!node_modules/react/**",
    "!node_modules/react-dom/**",
    // Browser bundles contain PDF.js and UI dependencies; Canvas is test-only.
    "!node_modules/pdfjs-dist/**",
    "!node_modules/@napi-rs/canvas*/**",
    "!node_modules/lucide-react/**",
    "!node_modules/@heroui/**",
    "!node_modules/react-aria/**",
    "!node_modules/react-aria-components/**",
    "!node_modules/react-stately/**",
    "!node_modules/@adobe/react-spectrum*/**",
    "!node_modules/@spectrum-icons/**",
  ],
  linux: {
    target: ["AppImage", "deb"],
    // 单个 PNG 会按原图像素建目录。1254 不在 hicolor 索引里，启动器会显示 Electron 齿轮。
    icon: "build/icons",
    category: "Utility",
    executableName: "aster",
    synopsis: "桌面 AI 助手",
    maintainer: "scopevar",
  },
  win: {
    target: "nsis",
    executableName: "aster",
    icon: "dist/desktop/assets/aster.ico",
  },
  deb: {
    depends: [
      "libasound2t64 | libasound2",
      "libatspi2.0-0t64 | libatspi2.0-0",
      "libgbm1",
      "libgtk-3-0t64 | libgtk-3-0",
      "libnotify4",
      "libnss3",
      "libsecret-1-0",
      "libsecret-tools",
      "libuuid1",
      "libxss1",
      "libxtst6",
      "xdg-utils",
    ],
  },
};

if (repository) {
  const [owner, repo] = repository.split("/");
  config.publish = [
    {
      provider: "github",
      owner,
      repo,
      channel,
      releaseType: channel === "nightly" ? "prerelease" : "release",
    },
  ];
} else if (feedUrl)
  config.publish = [
    {
      provider: "generic",
      url: feedUrl,
      channel,
      useMultipleRangeRequest: false,
    },
  ];

export default config;
