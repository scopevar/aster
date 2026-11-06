import { pythonAssets } from "./assets-manifest.js";

// Fixed CPython 3.12 Linux wheels; native libraries are extracted inside the VM.
const wheels = {
  pure: [
    {
      file: "python_docx-1.2.0-py3-none-any.whl",
      url: "https://files.pythonhosted.org/packages/d0/00/1e03a4989fa5795da308cd774f05b704ace555a70f9bf9d3be057b680bcf/python_docx-1.2.0-py3-none-any.whl",
      sha256:
        "3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7",
    },
    {
      file: "typing_extensions-4.16.0-py3-none-any.whl",
      url: "https://files.pythonhosted.org/packages/49/d3/b8441a820a491ddfc024b0b0cf0393375b75ea13866d9c66727e54c2fc80/typing_extensions-4.16.0-py3-none-any.whl",
      sha256:
        "481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8",
    },
    {
      file: "xlrd-2.0.2-py2.py3-none-any.whl",
      url: "https://files.pythonhosted.org/packages/1a/62/c8d562e7766786ba6587d09c5a8ba9f718ed3fa8af7f4553e8f91c36f302/xlrd-2.0.2-py2.py3-none-any.whl",
      sha256:
        "ea762c3d29f4cca48d82df517b6d89fbce4db3107f9d78713e48cd321d5c9aa9",
    },
  ],
  x64: [
    {
      file: "pypdfium2-5.14.0-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
      url: "https://files.pythonhosted.org/packages/4f/a3/c9cc797fc8bdfb8f37b9b0f8b9d02a5fc196b2015f408d53624cab5b0519/pypdfium2-5.14.0-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
      sha256:
        "11f281613fa22313d9c7ab89947665e84eccf8ebe40e1198a84a88352305648d",
    },
    {
      file: "lxml-6.1.3-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
      url: "https://files.pythonhosted.org/packages/db/36/aa413bc214dc4f785ad2b2ddd8cc99aae7062d49ab155e91e6011af00daf/lxml-6.1.3-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
      sha256:
        "379f8a75cf6eb7eef0af074b55f49ab73b868388a98de14646abcdfa4564bb11",
    },
    {
      file: "pillow-13.0.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl",
      url: "https://files.pythonhosted.org/packages/e6/99/fdf65cc539e266ab93546c261bdf98411fe165c6e4e13f9dbf597097192b/pillow-13.0.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl",
      sha256:
        "42d63be3af4f9b951b199b0a9d23365d37ab14687e6d77b74940432c8515c4ca",
    },
    {
      file: "av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.whl",
      url: "https://files.pythonhosted.org/packages/e1/7f/9f1237feb894afa472ef834aa1fbfe4d6398f28dc7e86a1b418650204c36/av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.whl",
      sha256:
        "9c1da7aad0fa6c13b4a5c1e7985be0d13f8526a96284573acaf3d55ead6d3fe8",
    },
  ],
  arm64: [
    {
      file: "pypdfium2-5.14.0-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.whl",
      url: "https://files.pythonhosted.org/packages/92/b4/0c31aa51887cd6cd032191dfe010a6d01ed43cf03204cfbd2184ebe4b715/pypdfium2-5.14.0-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.whl",
      sha256:
        "f1b696e6901e16f114a2ec6332e5e3f8f5033a901614ead28499ab18ca6024f5",
    },
    {
      file: "lxml-6.1.3-cp312-cp312-manylinux2014_aarch64.manylinux_2_17_aarch64.whl",
      url: "https://files.pythonhosted.org/packages/1e/1c/722e88883173097a1a375153e3c2447eba3060d0231522cf6596e99f4195/lxml-6.1.3-cp312-cp312-manylinux2014_aarch64.manylinux_2_17_aarch64.whl",
      sha256:
        "f683dc6300317700025e41d89a43e0276692ded16113a3c43eab704d605c58e5",
    },
    {
      file: "pillow-13.0.0-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl",
      url: "https://files.pythonhosted.org/packages/3b/bb/9e30e8ed18c20800ee327a12107d5249ad8dc444867b3adfcc21654e3c71/pillow-13.0.0-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl",
      sha256:
        "8bf295fe459343bc6093c8e5e0df60bfa189e0fcb775a22e2c2488fdeccc6c0d",
    },
    {
      file: "av-19.0.2-cp312-abi3-manylinux_2_28_aarch64.whl",
      url: "https://files.pythonhosted.org/packages/de/0c/448f89f76cf5e4da35dd6294a1e8155b75daa8839f2f2fa353775855d152/av-19.0.2-cp312-abi3-manylinux_2_28_aarch64.whl",
      sha256:
        "04c8e412642c652cb2b1997a9cb2114546ee7d894600c631f4be8ceb26a0d0d2",
    },
  ],
} as const;

export function pythonPackages(arch: "x64" | "arm64") {
  return [...pythonAssets, ...wheels.pure, ...wheels[arch]];
}
