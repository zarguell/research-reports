#!/usr/bin/env python3
"""Lint wikilinks in content/ — verify every [[link]] points to an existing file."""

import re
import sys
from pathlib import Path

CONTENT_DIR = Path(__file__).resolve().parent.parent / "content"
WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")

errors = []
for md_file in sorted(CONTENT_DIR.glob("**/*.md")):
    rel = md_file.relative_to(CONTENT_DIR)
    if rel.parts[0] in (".obsidian", "templates"):
        continue
    for line_num, line in enumerate(md_file.read_text().splitlines(), 1):
        for match in WIKILINK_RE.finditer(line):
            target = match.group(1).strip()
            target_path = CONTENT_DIR / f"{target}.md"
            if not target_path.exists():
                errors.append((str(rel), line_num, target))

if errors:
    for file, line, target in errors:
        print(f"  {file}:{line}  [[{target}]]")
    print(f"\n{len(errors)} dead wikilink(s) found.")
    sys.exit(1)
else:
    print("All wikilinks valid.")
    sys.exit(0)
