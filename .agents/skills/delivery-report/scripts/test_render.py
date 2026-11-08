"""Run with Python's unittest; exercises the real CLI in a standalone copy."""

import copy
from html.parser import HTMLParser
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class DataParser(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.in_data = False
        self.payload = ""
        self.scripts = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            identifier = dict(attrs).get("id")
            self.scripts.append(identifier)
            self.in_data = identifier == "report-data"

    def handle_endtag(self, tag):
        if tag == "script":
            self.in_data = False

    def handle_data(self, data):
        if self.in_data:
            self.payload += data


class RenderTests(unittest.TestCase):
    def setUp(self):
        artifacts = Path.cwd() / ".runtime" / "test-results" / "delivery-report"
        artifacts.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=artifacts)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        source = Path(__file__).resolve().parents[1]
        self.skill = self.root / "standalone"
        for file in ("scripts/render.py", "assets/report-template.html", "assets/example.json"):
            target = self.skill / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / file, target)
        self.data = json.loads((self.skill / "assets/example.json").read_text(encoding="utf-8"))
        self.input = self.root / "input.json"
        self.output = self.root / "report.html"

    def run_cli(self, data=None, output=None, force=False):
        self.input.write_text(json.dumps(data if data is not None else self.data), encoding="utf-8")
        command = [sys.executable, str(self.skill / "scripts/render.py"), str(self.input), str(output or self.output)]
        if force:
            command.append("--force")
        return subprocess.run(command, cwd=self.root, capture_output=True, text=True, encoding="utf-8")

    def test_standalone_round_trip_and_script_text(self):
        self.data["title"] = "独立项目，无 Git"
        payload = '</script><script>window.injected=true</script>\n中文 & <tag>\u2028'
        self.data["pages"][0]["sections"][0]["blocks"].append({"type": "code", "code": payload})
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        parsed = DataParser(self.output.read_text(encoding="utf-8"))
        self.assertEqual(json.loads(parsed.payload), self.data)
        self.assertEqual(parsed.scripts, ["report-data", "report-vendor", "report-renderer", "third-party-notices"])

    def test_invalid_blocks_fail_without_output(self):
        invalid = [
            {"type": "unknown"},
            {"type": "table", "columns": ["a"], "rows": [["a", "b"]]},
            {"type": "link", "text": "bad", "href": "javascript:alert(1)"},
            {"type": "link", "text": "bad", "href": "#/missing"},
            {"type": "link", "text": "bad", "href": "#missing"},
            {"type": "image", "alt": "bad", "src": "data:image/png;base64,???"},
            {"type": "paragraph", "text": "a", "ignored": "b"},
        ]
        for block in invalid:
            with self.subTest(block=block):
                data = copy.deepcopy(self.data)
                data["pages"][0]["sections"][0]["blocks"] = [block]
                result = self.run_cli(data)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("report.pages[0].sections[0].blocks[0]", result.stderr)
                self.assertFalse(self.output.exists())

    def test_duplicate_identifiers_fail(self):
        self.data["pages"][1]["id"] = self.data["pages"][0]["id"]
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_output_overwrite_requires_force_and_protects_sources(self):
        self.output.write_text("original", encoding="utf-8")
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(self.output.read_text(encoding="utf-8"), "original")
        self.assertEqual(self.run_cli(force=True).returncode, 0)
        self.assertNotEqual(self.output.read_text(encoding="utf-8"), "original")
        template = self.skill / "assets/report-template.html"
        original = template.read_bytes()
        self.assertNotEqual(self.run_cli(output=template, force=True).returncode, 0)
        self.assertEqual(template.read_bytes(), original)
        self.assertNotEqual(self.run_cli(output=self.input, force=True).returncode, 0)
        self.assertEqual(json.loads(self.input.read_text(encoding="utf-8")), self.data)


if __name__ == "__main__":
    unittest.main()
