"""Fill the self-contained HTML template. Python 3.10+, standard library only."""

import argparse
import base64
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit


def record(value, path, required, optional=()):
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected an object")
    missing = set(required) - value.keys()
    extra = value.keys() - set(required) - set(optional)
    if missing or extra:
        raise ValueError(f"{path}: missing {sorted(missing)}, unknown {sorted(extra)}")
    return value


def text(value, path, nonempty=False):
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise ValueError(f"{path}: expected {'non-empty ' if nonempty else ''}text")
    return value


def array(value, path, nonempty=False):
    if not isinstance(value, list) or (nonempty and not value):
        raise ValueError(f"{path}: expected {'non-empty ' if nonempty else ''}array")
    return value


def optional_text(obj, path, names):
    for name in names:
        if name in obj:
            text(obj[name], f"{path}.{name}")


def link(value, path, links):
    value = text(value, path, True)
    if value != value.strip() or re.search(r"[\x00-\x20\x7f\\]", value):
        raise ValueError(f"{path}: encode spaces and do not use controls or backslashes")
    parsed = urlsplit(value)
    if parsed.scheme not in ("", "https", "http", "mailto") or value.startswith("//"):
        raise ValueError(f"{path}: unsupported link scheme")
    if parsed.scheme in ("http", "https") and not parsed.netloc:
        raise ValueError(f"{path}: missing URL host")
    links.append((value, path))


def blocks(values, path, links, depth=0):
    if depth > 12:
        raise ValueError(f"{path}: content nesting exceeds 12 levels")
    for i, item in enumerate(array(values, path, True)):
        here = f"{path}[{i}]"
        if not isinstance(item, dict):
            raise ValueError(f"{here}: expected an object")
        kind = item.get("type")
        if kind == "paragraph":
            record(item, here, ("type", "text"))
            text(item["text"], here + ".text")
        elif kind == "list":
            record(item, here, ("type", "items"), ("ordered",))
            if "ordered" in item and type(item["ordered"]) is not bool:
                raise ValueError(f"{here}.ordered: expected boolean")
            for j, value in enumerate(array(item["items"], here + ".items", True)):
                text(value, f"{here}.items[{j}]")
        elif kind == "table":
            record(item, here, ("type", "columns", "rows"))
            columns = array(item["columns"], here + ".columns", True)
            for j, value in enumerate(columns):
                text(value, f"{here}.columns[{j}]", True)
            for j, row in enumerate(array(item["rows"], here + ".rows")):
                array(row, f"{here}.rows[{j}]")
                if len(row) != len(columns):
                    raise ValueError(f"{here}.rows[{j}]: column count does not match")
                for k, value in enumerate(row):
                    text(value, f"{here}.rows[{j}][{k}]")
        elif kind == "code":
            record(item, here, ("type", "code"), ("title",))
            text(item["code"], here + ".code")
            optional_text(item, here, ("title",))
        elif kind == "callout":
            record(item, here, ("type", "text"), ("title", "tone"))
            text(item["text"], here + ".text")
            optional_text(item, here, ("title", "tone"))
            if item.get("tone", "info") not in ("info", "warn", "error", "success"):
                raise ValueError(f"{here}.tone: expected info, warn, error or success")
        elif kind == "details":
            record(item, here, ("type", "title", "blocks"))
            text(item["title"], here + ".title", True)
            blocks(item["blocks"], here + ".blocks", links, depth + 1)
        elif kind in ("steps", "cards", "tabs"):
            record(item, here, ("type", "items"))
            for j, entry in enumerate(array(item["items"], here + ".items", True)):
                entry_path = f"{here}.items[{j}]"
                required = {"steps": ("title", "text"), "cards": ("title", "href"),
                            "tabs": ("title", "blocks")}[kind]
                record(entry, entry_path, required, ("description",) if kind == "cards" else ())
                text(entry["title"], entry_path + ".title", True)
                if kind == "steps":
                    text(entry["text"], entry_path + ".text")
                elif kind == "cards":
                    optional_text(entry, entry_path, ("description",))
                    link(entry["href"], entry_path + ".href", links)
                else:
                    blocks(entry["blocks"], entry_path + ".blocks", links, depth + 1)
        elif kind == "link":
            record(item, here, ("type", "text", "href"))
            text(item["text"], here + ".text", True)
            link(item["href"], here + ".href", links)
        elif kind == "image":
            record(item, here, ("type", "src", "alt"), ("caption",))
            text(item["alt"], here + ".alt", True)
            optional_text(item, here, ("caption",))
            source = text(item["src"], here + ".src", True)
            if not re.match(r"^data:image/(png|jpeg|gif|webp);base64,", source):
                raise ValueError(f"{here}.src: embed a PNG/JPEG/GIF/WebP data URL")
            try:
                image = base64.b64decode(source.split(",", 1)[1], validate=True)
            except ValueError as error:
                raise ValueError(f"{here}.src: invalid base64 image") from error
            if not image:
                raise ValueError(f"{here}.src: empty image")
        else:
            raise ValueError(f"{here}.type: unsupported content type {kind!r}")


def validate(data):
    record(data, "report", ("version", "title", "pages"), ("subtitle", "status"))
    if type(data["version"]) is not int or data["version"] != 1:
        raise ValueError("report.version: expected 1")
    text(data["title"], "report.title", True)
    optional_text(data, "report", ("subtitle", "status"))
    ids, page_ids, section_ids, links = set(), set(), set(), []

    def identifier(value, path, target):
        text(value, path, True)
        if not re.fullmatch(r"[a-z][a-z0-9-]*", value) or value in ids:
            raise ValueError(f"{path}: expected a unique lowercase identifier")
        ids.add(value)
        target.add(value)

    for i, page in enumerate(array(data["pages"], "report.pages", True)):
        path = f"report.pages[{i}]"
        record(page, path, ("id", "title", "sections"), ("description", "group"))
        identifier(page["id"], path + ".id", page_ids)
        text(page["title"], path + ".title", True)
        optional_text(page, path, ("description", "group"))
        for j, section in enumerate(array(page["sections"], path + ".sections", True)):
            here = f"{path}.sections[{j}]"
            record(section, here, ("id", "title", "blocks"))
            identifier(section["id"], here + ".id", section_ids)
            text(section["title"], here + ".title", True)
            blocks(section["blocks"], here + ".blocks", links)
    for href, path in links:
        if href.startswith("#/") and href[2:] not in page_ids:
            raise ValueError(f"{path}: unknown chapter {href}")
        if href.startswith("#") and not href.startswith("#/") and href[1:] not in section_ids:
            raise ValueError(f"{path}: unknown section {href}")


def render(data, template):
    validate(data)
    start_marker = "<!-- REPORT_DATA_START -->"
    end_marker = "<!-- REPORT_DATA_END -->"
    if template.count(start_marker) != 1 or template.count(end_marker) != 1:
        raise ValueError("template: expected one report data region")
    start = template.index(start_marker) + len(start_marker)
    end = template.index(end_marker)
    if end < start:
        raise ValueError("template: invalid report data region")
    # A literal </script> in a log must remain data, never become HTML markup.
    payload = json.dumps(data, ensure_ascii=False, indent=2).replace("<", "\\u003c")
    payload = payload.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return template[:start] + '\n<script id="report-data" type="application/json">\n' + payload + '\n</script>\n' + template[end:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data", type=Path, help="UTF-8 report JSON")
    parser.add_argument("output", type=Path, help="output HTML")
    parser.add_argument("--force", action="store_true", help="replace an existing report")
    args = parser.parse_args()
    template = Path(__file__).resolve().parents[1] / "assets" / "report-template.html"
    try:
        if args.output.resolve() in (args.data.resolve(), template.resolve()):
            raise ValueError("output must differ from input data and the template")
        data = json.loads(args.data.read_text(encoding="utf-8-sig"))
        html = render(data, template.read_text(encoding="utf-8"))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w" if args.force else "x", encoding="utf-8", newline="\n") as file:
            file.write(html)
    except (OSError, ValueError) as error:
        print(f"Cannot generate report: {error}", file=sys.stderr)
        return 1
    print(f"Generated {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
