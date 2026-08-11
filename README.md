# gnome-cricket-score

Live cricket scores in the GNOME top panel. Uses ESPN’s free public scoreboard API — no API key or signup required.

## Requirements

- GNOME Shell 45 or newer
- Network access to `site.web.api.espn.com`

## Install (local)

```bash
./install.sh
```

Or:

```bash
make install
```

Then restart GNOME Shell and enable:

```bash
gnome-extensions enable gnome-cricket-score@krushnaj.github.io
```

- **Wayland:** log out and log back in (required — `enable` fails until then with “does not exist”)
- **X11:** `Alt+F2`, type `r`, Enter, then run the enable command above

Or use the **Extensions** app and toggle **gnome-cricket-score** on.

## Usage

- By default the top panel shows only a **bat and ball icon** (no score).
- Click the indicator for a menu with **Live** and **Matches** tabs.
- In **Matches**, click a match to pin its score on the panel.
- Click the same match again, or choose **Clear selection (icon only)**, to go back to the icon.
- The **Live** tab shows a Cricinfo-style summary: current batters, bowlers, recent overs, partnership, and reviews.
- Polls every **10 seconds** by default (configurable in preferences).

## Preferences

Open the extension settings (Extensions app → gnome-cricket-score → gear icon):

- **Refresh interval** — poll period in seconds (default 10)
- **Panel position** — left, center, or right of the top panel

## Uninstall

```bash
make uninstall
```

## License

[GPL-3.0-or-later](LICENSE) (compatible with GNOME Shell’s GPL-2.0-or-later).

## Code of Conduct

This project follows the [GNOME Code of Conduct](https://conduct.gnome.org/). See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Data source

Scores come from:

```
https://site.web.api.espn.com/apis/personalized/v2/scoreboard/header?sport=cricket
```

Scorecards / live summary come from:

```
https://site.web.api.espn.com/apis/site/v2/sports/cricket/{leagueId}/summary?event={eventId}
https://site.web.api.espn.com/apis/site/v2/sports/cricket/{leagueId}/playbyplay?event={eventId}
```

These are unofficial public endpoints. ESPN may change or restrict them without notice.
