#!/usr/bin/env bash
set -euo pipefail

UUID="gnome-cricket-score@krushnaj.github.io"
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

# Remove previous UUID installs if present
for OLD_UUID in \
  cricket-score@cricket-gnome-extension \
  cricket-score@krushnaj.github.io \
  cricket-score@krushna.github.io
do
  OLD_EXT="${HOME}/.local/share/gnome-shell/extensions/${OLD_UUID}"
  if [[ -d "${OLD_EXT}" ]]; then
    rm -rf "${OLD_EXT}"
    echo "Removed old install at ${OLD_EXT}"
  fi
done

echo "Installed to ${EXT}"
echo
if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
  echo "You are on Wayland. Log out and log back in, then the extension will load."
  echo "It is already marked enabled in settings; after login it should appear in the panel."
  echo
  echo "If it does not, run:"
  echo "  gnome-extensions enable ${UUID}"
else
  echo "Restart GNOME Shell (Alt+F2, type r, Enter), then run:"
  echo "  gnome-extensions enable ${UUID}"
fi
