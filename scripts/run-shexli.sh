#!/usr/bin/env bash
# Run Shexli against the packed extension (or .shexli-pkg/).
# shexli 0.2.1 can segfault on lifecycle/logging AST rules (tree-sitter UAF);
# this wrapper uses a per-parse Parser and skips those rules so packaging
# checks still run. Re-run full `shexli <zip>` when a fixed release is out.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d venv ]]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv venv --python 3.12
    # shellcheck disable=SC1091
    source venv/bin/activate
    uv pip install -U shexli
  else
    python3 -m venv venv
    # shellcheck disable=SC1091
    source venv/bin/activate
    pip install -U shexli
  fi
else
  # shellcheck disable=SC1091
  source venv/bin/activate
fi

glib-compile-schemas schemas/
rm -f gnome-cricket-score@krushnaj.github.io.shell-extension.zip
gnome-extensions pack --force --extra-source=icons --extra-source=LICENSE

rm -rf .shexli-pkg
mkdir -p .shexli-pkg
unzip -q gnome-cricket-score@krushnaj.github.io.shell-extension.zip -d .shexli-pkg

python - <<'PY'
import json
import os
from pathlib import Path

from tree_sitter import Parser

import shexli.analyzer.core as core
import shexli.analyzer.rules as rules
import shexli.ast as ast_mod
from shexli.analyzer.core import analyze_path
from shexli.cli import _write_text

# Shared PARSER.parse() invalidates prior Trees in shexli 0.2.1
_trees = []

def parse_js_safe(source: str):
    parser = Parser(ast_mod.JS_LANGUAGE)
    tree = parser.parse(source.encode("utf-8"))
    _trees.append((parser, tree))
    return tree

ast_mod.parse_js = parse_js_safe
core.parse_js = parse_js_safe
Path.resolve = lambda self, strict=False: Path(os.path.abspath(str(self)))

# Rules that currently segfault on this package / shexli version
skip_js = {"ExcessiveLoggingRule", "ObfuscationRule", "ApiMisuseRule"}
skip_ext = {
    "LifecycleObjectsRule",
    "LifecyclePreEnableRule",
    "LifecycleReleaseRule",
    "LifecycleSignalsRule",
    "LifecycleSoupRule",
    "LifecycleSourcesRule",
}
rules.JS_FILE_RULES = tuple(
    r for r in rules.JS_FILE_RULES if type(r).__name__ not in skip_js
)
rules.EXTENSION_RULES = tuple(
    r for r in rules.EXTENSION_RULES if type(r).__name__ not in skip_ext
)
core.JS_FILE_RULES = rules.JS_FILE_RULES
core.EXTENSION_RULES = rules.EXTENSION_RULES

target = Path(".shexli-pkg").resolve()
result = analyze_path(target)
_write_text(result)
Path("shexli-report.json").write_text(json.dumps(result.to_dict(), indent=2) + "\n")

if result.summary.get("status") != "clean":
    raise SystemExit(1)
PY
