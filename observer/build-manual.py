from pathlib import Path
import html
import re
import json
import sys


def inline(value):
    value = html.escape(value)
    value = re.sub(r"`([^`]+)`", r"<code>\1</code>", value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", value)
    def link(match):
        target = match[2]
        pages = {"wmediumd-console-ng.md": "/ng/manual.html",
                 "console-rf-properties.md": "/ng/rf-properties.html"}
        destination = pages.get(target.split("#")[0].rsplit("/", 1)[-1])
        if destination and "#" in target:
            destination += "#" + target.split("#", 1)[1]
        if target.startswith("#"):
            destination = target
        return f'<a href="{destination}">{match[1]}</a>' if destination else match[1]

    value = re.sub(r"\[([^]]+)\]\(([^)]+)\)", link, value)
    return value


def render(source):
    blocks = []
    paragraph = []
    listing = None

    def flush():
        if paragraph:
            blocks.append("<p>" + inline(" ".join(paragraph)) + "</p>")
            paragraph.clear()

    for line in source.splitlines() + [""]:
        heading = re.match(r"^(#{1,3}) (.+)$", line)
        item = re.match(r"^(?:- |\d+\. )(.+)$", line)
        if not line or heading or item:
            flush()
        if listing and (not line or heading):
            blocks.append(f"</{listing}>")
            listing = None
        if heading:
            level = len(heading[1])
            anchor = re.sub(r"[^a-z0-9 -]", "", heading[2].lower()).replace(" ", "-")
            blocks.append(f'<h{level} id="{anchor}">{inline(heading[2])}</h{level}>')
        elif item:
            kind = "ul" if line.startswith("- ") else "ol"
            if listing != kind:
                if listing:
                    blocks.append(f"</{listing}>")
                blocks.append(f"<{kind}>")
                listing = kind
            blocks.append("<li>" + inline(item[1]) + "</li>")
        elif line:
            if listing and line.startswith("  ") and blocks[-1].endswith("</li>"):
                blocks[-1] = blocks[-1][:-5] + " " + inline(line.strip()) + "</li>"
            else:
                paragraph.append(line.strip())
    return "\n".join(blocks)


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    sys.path[:0] = [str(here.parents[1] / "optimizer"), str(here.parent / "configurator")]
    from optimizer.rf_observations import property_catalog
    from wmdcfg.protocol_registry import protocol_registry
    catalog = json.dumps({**property_catalog(), "protocol": protocol_registry()}, indent=2) + "\n"
    (here / "web/ng/rf-catalog.json").write_text(catalog)
    (here.parent / "configurator/worlds/viewer/rf-catalog.json").write_text(catalog)
    for document, filename in [
        ("guide/wmediumd-console-ng.md", "manual.html"),
        ("reference/radio/console-rf-properties.md", "rf-properties.html"),
    ]:
        source = (here.parents[2] / "doc/easymesh" / document).read_text()
        contents = render(source)
        sections = re.findall(r'<h2 id="([^"]+)">([^<]+)</h2>', contents)
        index = '<details><summary>On this page</summary><ul>' + "".join(
            f'<li><a href="#{anchor}">{title}</a></li>' for anchor, title in sections
        ) + '</ul></details>'
        title = html.escape(source.splitlines()[0].lstrip("# "))
        (here / "web/ng" / filename).write_text(
            '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{title}</title><link rel="stylesheet" href="/ng/style.css">'
            '</head><body><article class="manual"><nav><a href="/">← Console NG</a>'
            '<a href="/ng/manual.html">Operator manual</a>'
            '<a href="/ng/rf-properties.html">RF properties</a></nav>'
            + index + contents + '</article></body></html>\n'
        )
