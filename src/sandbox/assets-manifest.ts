export const microsandboxVersion = "0.7.11";
export const scriptImage =
  "docker.io/library/python@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c";
export const nodeVersion = "22.23.1";
export const nodeAssets = {
  x64: {
    archive: "7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129",
    binary: "93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068",
  },
  arm64: {
    archive: "543fa39e57d4c07855939459a323f4deb9a79dd1bb45e6e99458b0f2de10db8d",
    binary: "d8fa08f79c8198c5a5ccc9faa5a69803052703fc9513f99e7200e0ab42e1d799",
  },
} as const;
export const pythonAssets = [
  {
    file: "openpyxl-3.1.5-py2.py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/openpyxl-3.1.5-py2.py3-none-any.whl",
    sha256: "5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2",
  },
  {
    file: "et_xmlfile-2.0.0-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/et_xmlfile-2.0.0-py3-none-any.whl",
    sha256: "7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa",
  },
] as const;
export const runtimeAssets = {
  "win32-x64": {
    package: "win32-x64-msvc",
    executable: "msb.exe",
    library: "libkrunfw.dll",
    msb: "e3029cecbe4c114b9c3d66d4917fb462cf70acb9b78df151bde8da039cee6f11",
    firmware:
      "7e79c47dde2d987edcbfc305472b4864c915afc4e53420b4c6c2ec751dc09eec",
  },
  "win32-arm64": {
    package: "win32-arm64-msvc",
    executable: "msb.exe",
    library: "libkrunfw.dll",
    msb: "49b8e3dcfbcd59c7eba56e1ae53d0332b43131c1ed5e267b339a72a9a96e7d03",
    firmware:
      "459abe732352638d7be4317db59e3bc7a040470e04284db0af97a94d65ff1125",
  },
  "linux-x64": {
    package: "linux-x64-gnu",
    executable: "msb",
    library: "libkrunfw.so",
    msb: "02230b0d0ccab4da487c96282ef06bc366a603f0b95201e999cf9e13df31767e",
    firmware:
      "3854efcd3fe625528fa00207d97586d9790db8c436bb6881a43986604336d18e",
  },
  "linux-arm64": {
    package: "linux-arm64-gnu",
    executable: "msb",
    library: "libkrunfw.so",
    msb: "ce6b85d71d73165d982745d3b85c425603157b8522f53f287b206a4f502de2d1",
    firmware:
      "2cec662bc03134d426f312aa9d72bfbd19d876f6f39d36395cb4d34862194d4e",
  },
  "darwin-arm64": {
    package: "darwin-arm64",
    executable: "msb",
    library: "libkrunfw.dylib",
    msb: "7b179006af9b6258be23f3dfbd8476c5c07367493f39b874d595505044778738",
    firmware:
      "0fa7e81fdd3f7440f3ba3993379c06bb071355b71c7778ec3373246e8c1a0e91",
  },
} as const;
