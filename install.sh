#!/usr/bin/env bash
set -euo pipefail

UUID="cricket-score@krushnaj.github.io"
ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

cd "${ROOT}"
glib-compile-schemas schemas/

if command -v gnome-extensions >/dev/null 2>&1; then
  ZIP="${UUID}.shell-extension.zip"
  rm -f "${ZIP}"
  gnome-extensions pack --force --extra-source=icons --extra-source=LICENSE
  gnome-extensions install --force "./${ZIP}"
  rm -f "${ZIP}"
  glib-compile-schemas "${EXT}/schemas/"
  mkdir -p "${EXT}/icons"
  cp -f icons/*.svg "${EXT}/icons/"
else
  mkdir -p "${EXT}/schemas" "${EXT}/icons"
  cp -f metadata.json extension.js stylesheet.css prefs.js LICENSE "${EXT}/"
  cp -f schemas/*.xml schemas/gschemas.compiled "${EXT}/schemas/"
  cp -f icons/*.svg "${EXT}/icons/"
fi

# Remove previous UUID install if present
OLD_EXT="${HOME}/.local/share/gnome-shell/extensions/cricket-score@cricket-gnome-extension"
if [[ -d "${OLD_EXT}" ]]; then
  rm -rf "${OLD_EXT}"
  echo "Removed old install at ${OLD_EXT}"
fi

echo "Installed to ${EXT}"
echo "Restart GNOME Shell (logout on Wayland, or Alt+F2 → r on X11), then run:"
echo "  gnome-extensions enable ${UUID}"
