// gnome-cricket-score - GNOME Shell Extension
// SPDX-License-Identifier: GPL-3.0-or-later
// Data source: ESPN public cricket scoreboard + match summary (no API key).
// Requires GNOME Shell 45+ (ESM).

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const API_URL =
    'https://site.web.api.espn.com/apis/personalized/v2/scoreboard/header?sport=cricket';
const ESPN_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_LIVE_URL = 'https://www.espncricinfo.com/live-cricket-scores';

function summaryUrl(leagueId, eventId) {
    return `https://site.web.api.espn.com/apis/site/v2/sports/cricket/${leagueId}/summary?event=${eventId}&lang=en&region=in`;
}

function playByPlayUrl(leagueId, eventId, {limit = 50, page = null} = {}) {
    let url =
        `https://site.web.api.espn.com/apis/site/v2/sports/cricket/${leagueId}/playbyplay?event=${eventId}&limit=${limit}`;
    if (page != null)
        url += `&page=${page}`;
    return url;
}

function formatMatchStartLocal(isoDate) {
    if (!isoDate)
        return null;

    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime()))
        return null;

    const time = date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
    });
    const day = date.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
    });
    const today = new Date();
    const isToday = date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate();

    return isToday ? `Starts at ${time}` : `Starts ${day}, ${time}`;
}

function overOrdinal(n) {
    const num = Number(n) || 0;
    const v = num % 100;
    if (v >= 11 && v <= 13)
        return `${num}th`;
    switch (v % 10) {
    case 1: return `${num}st`;
    case 2: return `${num}nd`;
    case 3: return `${num}rd`;
    default: return `${num}th`;
    }
}

function ballLabelFromPlay(item) {
    const desc = ((item.playType || {}).description || '').toLowerCase();
    const score = Number(item.scoreValue) || 0;
    const dismissed = !!(item.dismissal && item.dismissal.dismissal) || desc === 'out';
    const over = item.over || {};

    if (dismissed)
        return {label: 'W', kind: 'wicket'};
    if (desc.includes('wide') || Number(over.wide) > 0)
        return {label: `${Math.max(score, 1)}w`, kind: 'extra'};
    if (desc.includes('no ball') || desc.includes('no-ball') || Number(over.noBall) > 0) {
        const runs = score > 1 ? String(score) : '';
        return {label: `${runs}nb` || 'nb', kind: 'extra'};
    }
    if (desc.includes('leg bye'))
        return {label: score ? `${score}lb` : 'lb', kind: 'extra'};
    if (desc === 'bye' || desc.includes('bye'))
        return {label: score ? `${score}b` : 'b', kind: 'extra'};
    if (desc === 'six' || score === 6)
        return {label: '6', kind: 'six'};
    if (desc === 'four' || score === 4)
        return {label: '4', kind: 'four'};
    if (score === 0 || desc === 'no run')
        return {label: '·', kind: 'dot'};
    return {label: String(score), kind: 'run'};
}

function addStaticLine(menu, text, styleClass = 'cricket-scorecard-line') {
    const item = new PopupMenu.PopupMenuItem(text, {
        reactive: false,
        can_focus: false,
    });
    if (item.label)
        item.label.add_style_class_name(styleClass);
    menu.addMenuItem(item);
    return item;
}

function makeGridLabel(text, {
    expand = false,
    width = null,
    align = Clutter.ActorAlign.START,
    styleClass = 'cricket-grid-cell',
    ellipsize = false,
} = {}) {
    const label = new St.Label({
        text: text || '',
        y_align: Clutter.ActorAlign.CENTER,
        x_align: align,
        x_expand: expand,
        style_class: styleClass,
    });

    if (width)
        label.style = `min-width: ${width}px;`;

    if (ellipsize) {
        label.clutter_text.set({
            ellipsize: Pango.EllipsizeMode.END,
        });
    }

    return label;
}

function addGridRow(menu, cells, {header = false} = {}) {
    const row = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
        style_class: header ? 'cricket-grid-header-row' : 'cricket-grid-data-row',
    });

    const box = new St.BoxLayout({
        style_class: 'cricket-grid-row',
        x_expand: true,
    });

    for (const cell of cells)
        box.add_child(makeGridLabel(cell.text, cell));

    row.add_child(box);
    menu.addMenuItem(row);
    return row;
}

function addSectionTitle(menu, text) {
    return addStaticLine(menu, text, 'cricket-scorecard-section');
}

function truncateName(name, max = 20) {
    const value = name || '';
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function liveRole(player) {
    return String(player?.activeName || '').toLowerCase().trim();
}

function formatFaced(runs, balls) {
    if (runs == null || balls == null || runs === '' || balls === '')
        return '';
    return `${runs} (${balls}b)`;
}

function formatSpell(spell) {
    if (spell?.overs == null || spell.overs === '')
        return '';
    return `${spell.overs} - ${spell.maidens ?? 0} - ${spell.conceded ?? 0} - ${spell.wickets ?? 0}`;
}

function partnershipPersonName(person) {
    if (!person || typeof person !== 'object')
        return '';
    return person.athlete?.displayName ||
        person.player?.displayName ||
        person.displayName ||
        person.shortName ||
        person.name ||
        '';
}

// Normalize overs like "9", "9.0", "9.00" for delay-note matching.
function normalizeOversValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return String(value ?? '');
    const whole = Math.floor(n);
    const balls = Math.round((n - whole) * 10);
    return balls ? `${whole}.${balls}` : String(whole);
}

// LIVE / DRINKS / TEA / LUNCH / STUMPS / DINNER / RAIN / …
function normalizePlayStatus(raw, {isFinished = false} = {}) {
    if (isFinished)
        return 'RESULT';

    const text = String(raw || '').trim();
    if (!text)
        return 'LIVE';

    const lower = text.toLowerCase().replace(/\s+/g, ' ');

    if (/match delayed by rain|rain delay|\brain\b/.test(lower))
        return 'RAIN';
    if (/bad light/.test(lower))
        return 'BAD LIGHT';
    if (/wet ground/.test(lower))
        return 'WET GROUND';
    if (/\bdrinks\b/.test(lower))
        return 'DRINKS';
    if (/\blunch\b/.test(lower))
        return 'LUNCH';
    if (/\btea\b/.test(lower))
        return 'TEA';
    if (/\bdinner\b/.test(lower))
        return 'DINNER';
    if (/\bstumps\b|end of day\b|close of play\b/.test(lower))
        return 'STUMPS';
    if (/innings break/.test(lower))
        return 'INNINGS BREAK';
    if (/^live\b/.test(lower) || lower === 'in progress')
        return 'LIVE';

    // Situation lines ("Pakistan trail…") are not play-status badges
    if (text.length > 36 ||
        /\b(trail|lead|require|won by|need |target)\b/.test(lower))
        return 'LIVE';

    return text.toUpperCase();
}

function playStatusFromNotes(notes, battingOvers) {
    const matchNotes = (notes || []).filter(n =>
        n?.type === 'matchnote' && typeof n.text === 'string' && n.text
    );
    const currentOvers = battingOvers != null && battingOvers !== ''
        ? normalizeOversValue(battingOvers)
        : null;

    for (let i = matchNotes.length - 1; i >= 0; i--) {
        const text = matchNotes[i].text;
        const prefix = text.match(
            /^(Drinks|Lunch|Tea|Stumps|Dinner|Rain|Bad Light|Wet Ground|End Of Day|Innings Break)\b/i
        );
        if (!prefix)
            continue;

        const oversMatch = text.match(/in\s+([\d.]+)\s+overs/i);
        if (oversMatch && currentOvers) {
            if (normalizeOversValue(oversMatch[1]) !== currentOvers)
                continue;
        } else if (oversMatch && !currentOvers) {
            continue;
        }

        return normalizePlayStatus(prefix[1]);
    }

    return null;
}

function resolvePlayStatus({
    statusText = '',
    eventSummary = '',
    notes = null,
    battingOvers = null,
    isFinished = false,
    headerPlayStatus = '',
} = {}) {
    if (isFinished)
        return 'RESULT';

    const fromHeader = normalizePlayStatus(headerPlayStatus);
    if (fromHeader && fromHeader !== 'LIVE')
        return fromHeader;

    const fromStatus = normalizePlayStatus(statusText || eventSummary);
    if (fromStatus && fromStatus !== 'LIVE')
        return fromStatus;

    const fromNotes = playStatusFromNotes(notes, battingOvers);
    if (fromNotes && fromNotes !== 'LIVE')
        return fromNotes;

    return 'LIVE';
}

const MatchMenuItem = GObject.registerClass(
class MatchMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(matchData, {selected = false, onSelect = null} = {}) {
        super._init({reactive: true, can_focus: true});

        this._matchId = matchData.id;
        this._onSelect = onSelect;

        const card = new St.BoxLayout({
            vertical: true,
            style: 'padding: 4px 2px; spacing: 2px;',
            x_expand: true,
        });

        if (matchData.league) {
            card.add_child(new St.Label({
                text: matchData.league,
                style: 'font-size: 0.85em; opacity: 0.7;',
            }));
        }

        card.add_child(new St.Label({
            text: matchData.panelText,
            style: 'font-weight: bold;',
        }));

        if (matchData.isLive && matchData.playStatus && matchData.playStatus !== 'LIVE') {
            const status = new St.Label({
                text: matchData.playStatus,
                style_class: 'cricket-play-status cricket-play-status-delay',
                x_expand: true,
            });
            status.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            card.add_child(status);
        }

        if (matchData.context) {
            const contextStyle = matchData.isLive
                ? 'font-weight: bold; font-size: 0.9em;'
                : 'opacity: 0.75; font-size: 0.9em;';
            card.add_child(new St.Label({
                text: matchData.context,
                style: contextStyle,
            }));
        }

        this.add_child(card);

        if (selected)
            this.setOrnament(PopupMenu.Ornament.CHECK);
        else
            this.setOrnament(PopupMenu.Ornament.NONE);

        this.connect('activate', () => {
            if (this._onSelect)
                this._onSelect(this._matchId);
        });
    }
});

const CricketIndicator = GObject.registerClass(
class CricketIndicator extends PanelMenu.Button {
    _init(iconFile) {
        super._init(0.0, 'gnome-cricket-score', false);

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box cricket-panel-box',
        });

        this._icon = new St.Icon({
            style_class: 'system-status-icon cricket-panel-icon',
            icon_size: 16,
        });

        if (iconFile)
            this._icon.gicon = Gio.FileIcon.new(iconFile);
        else
            this._icon.icon_name = 'applications-games-symbolic';

        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cricket-score-label',
            visible: false,
        });

        this._box.add_child(this._icon);
        this._box.add_child(this._label);
        this.add_child(this._box);
    }

    showIconOnly() {
        this._label.visible = false;
        this._label.set_text('');
        this._label.remove_style_class_name('live');
    }

    setScore(text, isLive = false) {
        const value = (text || '').trim();
        if (!value) {
            this.showIconOnly();
            return;
        }

        this._label.set_text(value);
        this._label.visible = true;
        if (isLive)
            this._label.add_style_class_name('live');
        else
            this._label.remove_style_class_name('live');
    }
});

export default class CricketScoreExtension extends Extension {
    enable() {
        this._session = new Soup.Session();
        this._session.user_agent = ESPN_USER_AGENT;
        this._settings = this.getSettings();
        this._timeoutId = null;
        this._fetchInFlight = false;
        this._scorecardFetchInFlight = false;
        this._scorecardRefreshQueued = false;
        this._matches = [];
        this._scorecard = null;
        this._scorecardMatchKey = '';
        this._activeTab = 'matches';

        this._addIndicator();
        this._updatePanelDisplay(null);
        this._fetchScore();
        this._startPolling();

        this._settings.connectObject('changed', (_s, key) => {
            if (key === 'refresh-interval') {
                this._stopPolling();
                this._startPolling();
            } else if (key === 'panel-position') {
                this._repositionIndicator();
            } else if (key === 'selected-match-id') {
                this._applySelectedMatch();
            }
        }, this);
    }

    disable() {
        this._settings?.disconnectObject(this);

        this._disconnectMenuState();
        this._stopPolling();

        if (this._session) {
            this._session.abort();
            this._session = null;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        this._matches = [];
        this._scorecard = null;
        this._scorecardMatchKey = '';
        this._scorecardFetchInFlight = false;
        this._scorecardRefreshQueued = false;
        this._fetchInFlight = false;
        this._activeTab = 'matches';
    }

    _disconnectMenuState() {
        this._indicator?.menu.disconnectObject(this);
    }

    _addIndicator() {
        const position = this._settings.get_string('panel-position') || 'center';
        const iconFile = this.dir.get_child('icons').get_child('cricket-bat-ball-symbolic.svg');
        this._indicator = new CricketIndicator(iconFile.query_exists(null) ? iconFile : null);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, position);

        this._indicator.menu.connectObject(
            'open-state-changed',
            (_menu, isOpen) => {
                if (isOpen)
                    this._rebuildMenu(this._matches);
            },
            this
        );
    }

    _repositionIndicator() {
        this._disconnectMenuState();
        this._indicator?.destroy();
        this._indicator = null;
        this._addIndicator();
        this._updatePanelDisplay(this._getSelectedMatch(this._matches));
        this._fetchScore();
    }

    _startPolling() {
        this._stopPolling();
        const interval = this._settings?.get_int('refresh-interval') ?? 10;

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, interval),
            () => {
                this._fetchScore();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopPolling() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    _manualRefresh() {
        this._fetchScore();
    }

    _matchKey(match) {
        return `${match.leagueId}:${match.id}`;
    }

    _selectMatch(matchId) {
        if (!this._settings)
            return;

        const id = String(matchId);
        const current = this._settings.get_string('selected-match-id') || '';

        // Clicking the selected match again clears it back to icon-only
        if (current === id) {
            this._clearSelectedMatch();
            return;
        }

        this._settings.set_string('selected-match-id', id);
        this._activeTab = 'live';

        const match = this._matches.find(m => m.id === id);
        if (match) {
            this._updatePanelDisplay(match);
            this._fetchScorecard(match);
        }
    }

    _clearSelectedMatch() {
        if (!this._settings)
            return;
        this._settings.set_string('selected-match-id', '');
        this._scorecard = null;
        this._scorecardMatchKey = '';
        this._activeTab = 'matches';
        this._updatePanelDisplay(null);
        if (!this._indicator?.menu.isOpen)
            this._rebuildMenu(this._matches);
    }

    _updatePanelDisplay(match) {
        if (!this._indicator)
            return;

        if (!match) {
            this._indicator.showIconOnly();
            return;
        }

        this._indicator.setScore(match.panelText, match.isLive);
    }

    _buildPanelText(competitors) {
        if (!competitors || competitors.length < 2)
            return null;

        const parts = competitors.map(comp => {
            const abbr = comp?.abbreviation || comp?.name || comp?.displayName || '?';
            const score = (comp?.score || '').trim();
            return score ? `${abbr} ${score}` : abbr;
        });

        return parts.join(' v ');
    }

    _normalizeLink(url) {
        if (!url)
            return DEFAULT_LIVE_URL;
        return url.replace('www.espn.in', 'www.espncricinfo.com');
    }

    _parseApiData(apiData) {
        let leagues;
        try {
            leagues = apiData.sports[0].leagues;
        } catch (_e) {
            return [];
        }

        if (!Array.isArray(leagues))
            return [];

        const matches = [];

        for (const league of leagues) {
            const leagueId = String(league?.id || '');
            if (!leagueId)
                continue;

            const events = league?.events || [];
            for (const event of events) {
                const competitors = event?.competitors || [];
                if (competitors.length < 2)
                    continue;

                const fullStatus = event?.fullStatus || {};
                const statusType = fullStatus?.type || {};
                const state = statusType?.state || event?.status || '';

                const isLive = state === 'in';
                const hasStarted = state === 'in' || state === 'post';
                const isFinished = state === 'post';
                const isInternational = competitors.some(c => c?.isNational === true);

                const panelText = this._buildPanelText(competitors);
                if (!panelText)
                    continue;

                const id = String(event?.id || event?.competitionId || '');
                if (!id)
                    continue;

                // Upcoming matches: show start time in your system timezone
                let context = fullStatus?.summary || event?.summary || statusType?.detail || '';
                if (!hasStarted) {
                    const localStart = formatMatchStartLocal(event?.date || event?.startDate);
                    if (localStart)
                        context = localStart;
                }

                const playStatus = resolvePlayStatus({
                    statusText: statusType?.description || statusType?.detail || '',
                    eventSummary: event?.summary || '',
                    notes: event?.notes || [],
                    isFinished,
                });

                matches.push({
                    id,
                    leagueId,
                    panelText,
                    link: this._normalizeLink(event?.link),
                    isLive,
                    hasStarted,
                    isFinished,
                    isInternational,
                    venue: event?.location || '',
                    context,
                    playStatus,
                    league: league?.shortName || league?.name || '',
                    competitors,
                });
            }
        }

        return matches;
    }

    _statsMap(statsObj) {
        const out = {};
        for (const cat of statsObj?.categories || []) {
            for (const s of cat.stats || [])
                out[s.name] = s.displayValue ?? s.value;
        }
        return out;
    }

    // Stats for one innings. Do not use the first nonempty period — after
    // an innings change that is still the previous batting card.
    _playerPeriodStats(player, periodNumber) {
        const periods = player.linescores || [];
        let period = null;
        if (periodNumber != null && Number(periodNumber) > 0)
            period = periods.find(p => Number(p.period) === Number(periodNumber));
        if (!period)
            period = periods[periods.length - 1] || null;

        const inner = (period?.linescores || [])[0] || period || {};
        const st = inner.statistics || period?.statistics || player.statistics || {};
        return {
            map: this._statsMap(st),
            batting: st.batting || null,
            bowling: st.bowling || null,
        };
    }

    _makeBatter(name, teamAbbr, map, batting, role) {
        const pvp = batting?.pvp || {};
        const recent = batting?.battingRecent || batting?.lastTenOvers || {};
        return {
            name,
            team: teamAbbr,
            active: role === 'striker' || role === 'non-striker' || role === 'non striker',
            role,
            isStriker: role === 'striker',
            runs: map.runs ?? '0',
            balls: map.ballsFaced ?? '0',
            fours: map.fours ?? '0',
            sixes: map.sixes ?? '0',
            strikeRate: map.strikeRate ?? '-',
            thisBowler: formatFaced(pvp.runs, pvp.balls),
            lastTen: formatFaced(recent.runs, recent.balls),
        };
    }

    _makeBowler(name, teamAbbr, map, bowling, role) {
        const spell = bowling?.currentSpell || {};
        return {
            name,
            team: teamAbbr,
            active: role === 'current bowler' || role === 'previous bowler',
            isCurrent: role === 'current bowler',
            overs: map.overs ?? '0',
            maidens: map.maidens ?? '0',
            conceded: map.conceded ?? '0',
            wickets: map.wickets ?? '0',
            economy: map.economyRate ?? '-',
            dots: map.dots ?? map.dotBalls ?? '',
            fours: map.fours ?? '',
            sixes: map.sixes ?? '',
            thisSpell: formatSpell(spell),
            bowlingPosition: Number(map.bowlingPosition) || 0,
        };
    }

    _parseScorecard(apiData) {
        if (!apiData || typeof apiData !== 'object')
            return null;

        const header = apiData.header || {};
        const comp = (header.competitions || [])[0] || {};
        const status = comp.status || {};
        const statusType = status.type || {};

        const teams = (comp.competitors || []).map(c => {
            const team = c.team || {};
            return {
                id: String(c.id || team.id || ''),
                name: team.displayName || team.name || '',
                abbr: team.abbreviation || team.shortDisplayName || '',
                score: c.score || '',
                homeAway: c.homeAway || '',
                linescores: c.linescores || [],
            };
        });

        let toss = '';
        for (const note of apiData.notes || []) {
            if (note?.type === 'toss' && note.text) {
                toss = note.text.replace(/\s+,/, ',').trim();
                break;
            }
        }

        const currentPeriod = Number(status.period) || 0;
        const battingTeamId = String(status.battingTeamId || '');

        // isBatting on a linescore means "this team's batting innings", not
        // "currently batting". Use the current period's batting card.
        let battingLinescore = null;
        for (const team of teams) {
            for (const ls of team.linescores || []) {
                const isCurrent = Number(ls.isCurrent) === 1 ||
                    (currentPeriod > 0 && Number(ls.period) === currentPeriod);
                if (isCurrent && ls.isBatting) {
                    battingLinescore = {
                        ...ls,
                        teamAbbr: team.abbr,
                        teamName: team.name,
                        teamId: team.id,
                    };
                }
            }
        }
        if (!battingLinescore && battingTeamId) {
            const team = teams.find(t => t.id === battingTeamId);
            const ls = (team?.linescores || []).find(l => Number(l.isCurrent) === 1) ||
                (team?.linescores || []).find(l => Number(l.period) === currentPeriod);
            if (team && ls) {
                battingLinescore = {
                    ...ls,
                    teamAbbr: team.abbr,
                    teamName: team.name,
                    teamId: team.id,
                };
            }
        }

        const partnerships = battingLinescore?.partnerships || [];
        const currentPartnership = partnerships.length
            ? partnerships[partnerships.length - 1]
            : null;

        let lastBat = '';
        let fow = '';
        if (partnerships.length >= 2) {
            const fallen = partnerships[partnerships.length - 2];
            const currentNames = new Set(
                (currentPartnership?.batsmen || []).map(b => partnershipPersonName(b))
            );
            const dismissed = (fallen.batsmen || []).find(b =>
                !currentNames.has(partnershipPersonName(b))
            ) || fallen.batsmen?.[0];
            const dismissedName = partnershipPersonName(dismissed);
            if (dismissedName) {
                const faced = formatFaced(
                    dismissed.runs ?? dismissed.score,
                    dismissed.balls ?? dismissed.ballsFaced
                );
                lastBat = faced ? `${dismissedName} ${faced}` : dismissedName;
            }
            const wicketOver = fallen.wicketOver || fallen.end?.overs;
            const endRuns = fallen.end?.runs;
            const endWkts = fallen.end?.wickets ?? fallen.wicketNumber;
            if (endRuns != null && endWkts != null) {
                fow = wicketOver != null
                    ? `${endRuns}/${endWkts} (${wicketOver} Ov)`
                    : `${endRuns}/${endWkts}`;
            }
        }

        const reviews = [];
        for (const team of teams) {
            for (const ls of team.linescores || []) {
                if (ls.reviews) {
                    reviews.push({
                        team: team.abbr || team.name,
                        remaining: ls.reviews.remaining,
                        permitted: ls.reviews.reviewsPermitted,
                    });
                    break;
                }
            }
        }

        const batters = [];
        const bowlers = [];
        const battingId = battingLinescore?.teamId || battingTeamId;

        for (const roster of apiData.rosters || []) {
            const teamAbbr = roster?.team?.abbreviation || roster?.team?.displayName || '';
            for (const player of roster.roster || []) {
                const role = liveRole(player);
                const isStriker = role === 'striker';
                const isNonStriker = role === 'non-striker' || role === 'non striker';
                const isCurrentBowler = role === 'current bowler';
                const isPrevBowler = role === 'previous bowler';
                if (!isStriker && !isNonStriker && !isCurrentBowler && !isPrevBowler)
                    continue;

                const athlete = player.athlete || {};
                const name = athlete.displayName || athlete.shortName || athlete.name || '?';
                const {map, batting, bowling} = this._playerPeriodStats(player, currentPeriod);

                if (isStriker || isNonStriker)
                    batters.push(this._makeBatter(name, teamAbbr, map, batting, role));
                if (isCurrentBowler || isPrevBowler)
                    bowlers.push(this._makeBowler(name, teamAbbr, map, bowling, role));
            }
        }

        // Fallback if ESPN omitted live roles (innings break / incomplete payload)
        if (!batters.length) {
            for (const roster of apiData.rosters || []) {
                const teamId = String(roster?.team?.id || '');
                if (battingId && teamId !== battingId)
                    continue;
                const teamAbbr = roster?.team?.abbreviation || roster?.team?.displayName || '';
                for (const player of roster.roster || []) {
                    const {map, batting} = this._playerPeriodStats(player, currentPeriod);
                    if (String(map.batted) !== '1')
                        continue;
                    const dismissal = String(map.dismissalCard || '').toLowerCase();
                    if (dismissal && dismissal !== 'not out')
                        continue;
                    const athlete = player.athlete || {};
                    const name = athlete.displayName || athlete.shortName || athlete.name || '?';
                    batters.push(this._makeBatter(name, teamAbbr, map, batting, liveRole(player)));
                }
            }
        }

        if (!bowlers.length) {
            for (const roster of apiData.rosters || []) {
                const teamId = String(roster?.team?.id || '');
                if (battingId && teamId === battingId)
                    continue;
                const teamAbbr = roster?.team?.abbreviation || roster?.team?.displayName || '';
                for (const player of roster.roster || []) {
                    const {map, bowling} = this._playerPeriodStats(player, currentPeriod);
                    const overs = String(map.overs ?? '');
                    if (!overs || overs === '0' || overs === '0.0' || overs === '-')
                        continue;
                    const athlete = player.athlete || {};
                    const name = athlete.displayName || athlete.shortName || athlete.name || '?';
                    bowlers.push(this._makeBowler(name, teamAbbr, map, bowling, liveRole(player)));
                }
            }
            bowlers.sort((a, b) => (b.bowlingPosition || 0) - (a.bowlingPosition || 0));
            bowlers.splice(2);
        }

        batters.sort((a, b) => {
            if (a.isStriker !== b.isStriker)
                return a.isStriker ? -1 : 1;
            return 0;
        });
        bowlers.sort((a, b) => {
            if (a.isCurrent !== b.isCurrent)
                return a.isCurrent ? -1 : 1;
            return 0;
        });

        const inningsStats = this._statsMap(battingLinescore?.statistics);
        const runs = battingLinescore?.runs;
        const overs = battingLinescore?.overs;
        let runRate = inningsStats.runRate || battingLinescore?.runRate || '';
        if (!runRate && runs != null && overs != null && Number(overs) > 0) {
            const o = Number(overs);
            const whole = Math.floor(o);
            const balls = Math.round((o - whole) * 10);
            const totalBalls = whole * 6 + balls;
            if (totalBalls > 0)
                runRate = (Number(runs) * 6 / totalBalls).toFixed(2);
        }

        if (!teams.length && !batters.length && !bowlers.length)
            return null;

        const isFinished = statusType?.state === 'post';
        const playStatus = resolvePlayStatus({
            statusText: statusType.description || statusType.detail || statusType.statusPrimary || '',
            eventSummary: header.competitions?.[0]?.status?.type?.description || '',
            notes: apiData.notes || [],
            battingOvers: battingLinescore?.overs,
            isFinished,
        });

        return {
            summary: status.summary || '',
            session: status.session || '',
            displayPeriod: status.displayPeriod || '',
            statusText: statusType.description || statusType.detail || '',
            playStatus,
            venue: apiData.gameInfo?.venue?.fullName || '',
            toss,
            runRate,
            teams,
            batters,
            bowlers,
            overs: [],
            partnership: currentPartnership
                ? {
                    runs: currentPartnership.runs,
                    balls: currentPartnership.balls
                        ?? (currentPartnership.overs != null
                            ? (() => {
                                const o = Number(currentPartnership.overs);
                                const whole = Math.floor(o);
                                const balls = Math.round((o - whole) * 10);
                                return whole * 6 + balls;
                            })()
                            : null),
                    overs: currentPartnership.overs,
                    runRate: currentPartnership.runRate,
                }
                : null,
            reviews,
            lastBat,
            fow,
            battingScore: battingLinescore?.score || '',
            battingTeam: battingLinescore?.teamAbbr || battingLinescore?.teamName || '',
            battingTeamId: battingLinescore?.teamId || battingTeamId,
        };
    }

    _parseOvers(playByPlayData) {
        const items = playByPlayData?.commentary?.items;
        if (!Array.isArray(items) || !items.length)
            return [];

        const byOver = new Map();
        for (const item of items) {
            const overMeta = item.over || {};
            const number = Number(overMeta.number) || 0;
            if (!number)
                continue;

            if (!byOver.has(number)) {
                byOver.set(number, {
                    number,
                    runs: Number(overMeta.runs) || 0,
                    complete: !!overMeta.complete,
                    balls: [],
                });
            }

            const bucket = byOver.get(number);
            // Keep latest over.runs from ESPN
            if (overMeta.runs != null)
                bucket.runs = Number(overMeta.runs) || 0;
            bucket.complete = !!overMeta.complete;

            const ball = ballLabelFromPlay(item);
            bucket.balls.push(ball);
        }

        // Newest overs first (left side of strip) — current + previous only
        return [...byOver.values()]
            .sort((a, b) => b.number - a.number)
            .slice(0, 2);
    }

    _getSelectedMatch(matches) {
        const selectedId = this._settings?.get_string('selected-match-id') || '';
        if (!selectedId)
            return null;
        return matches.find(m => m.id === selectedId) ?? null;
    }

    _applySelectedMatch() {
        if (!this._indicator)
            return;

        const selected = this._getSelectedMatch(this._matches);
        this._updatePanelDisplay(selected);

        if (selected)
            this._fetchScorecard(selected);
        else {
            this._scorecard = null;
            this._scorecardMatchKey = '';
        }

        if (!this._indicator.menu.isOpen)
            this._rebuildMenu(this._matches);
    }

    _buildFallbackMenu(message) {
        if (!this._indicator)
            return;

        // Keep panel as icon-only; show the message only in the menu
        this._updatePanelDisplay(this._getSelectedMatch(this._matches));

        const menu = this._indicator.menu;
        menu.removeAll();

        menu.addMenuItem(new PopupMenu.PopupMenuItem(message, {
            reactive: false,
        }));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh Now');
        refreshItem.connect('activate', () => this._manualRefresh());
        menu.addMenuItem(refreshItem);
    }

    _addPlayStatusBadge(menu, playStatus) {
        const label = playStatus || 'LIVE';
        const isLive = label === 'LIVE';
        const item = addStaticLine(
            menu,
            label,
            isLive
                ? 'cricket-play-status cricket-play-status-live'
                : 'cricket-play-status cricket-play-status-delay'
        );
        if (item.label?.clutter_text) {
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            item.label.x_expand = true;
        }
    }

    _addScorecardToMenu(menu, selected) {
        if (!selected) {
            addStaticLine(menu, 'No match selected — pick one in Matches', 'cricket-scorecard-muted');
            return;
        }

        if (!this._scorecard || this._scorecardMatchKey !== this._matchKey(selected)) {
            addStaticLine(menu, 'Loading live summary…', 'cricket-scorecard-muted');
            return;
        }

        const sc = this._scorecard;

        this._addPlayStatusBadge(menu, sc.playStatus || 'LIVE');

        for (const team of sc.teams) {
            const isBatting = team.id === sc.battingTeamId ||
                team.abbr === sc.battingTeam ||
                team.name === sc.battingTeam;
            addGridRow(menu, [
                {
                    text: team.abbr || team.name,
                    expand: true,
                    styleClass: isBatting
                        ? 'cricket-grid-cell cricket-grid-team'
                        : 'cricket-grid-cell',
                },
                {
                    text: team.score || (isBatting ? sc.battingScore || '—' : 'yet to bat'),
                    width: 150,
                    align: Clutter.ActorAlign.END,
                    styleClass: isBatting
                        ? 'cricket-grid-cell cricket-grid-score'
                        : 'cricket-grid-cell cricket-grid-muted',
                },
            ]);
        }

        if (sc.session || sc.summary) {
            const statusLine = sc.session && sc.summary
                ? `${sc.session}: ${sc.summary}`
                : sc.summary || sc.session;
            addStaticLine(menu, statusLine, 'cricket-scorecard-muted');
        }

        const meta = [];
        if (sc.toss)
            meta.push(sc.toss.replace(/\s+/g, ' '));
        if (sc.runRate)
            meta.push(`Current RR: ${sc.runRate}`);
        if (meta.length)
            addStaticLine(menu, meta.join(' · '), 'cricket-scorecard-muted');

        // Batters
        if (sc.batters?.length) {
            addSectionTitle(menu, 'Batters');
            addGridRow(menu, [
                {text: 'Batter', expand: true, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: 'R', width: 32, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: 'B', width: 32, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: '4s', width: 28, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: '6s', width: 28, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: 'SR', width: 44, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: 'This Bowler', width: 72, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: 'Last 10', width: 72, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
            ], {header: true});

            for (const batter of sc.batters.slice(0, 2)) {
                const mark = batter.isStriker ? '*' : '';
                addGridRow(menu, [
                    {
                        text: `${truncateName(batter.name, 18)}${mark}`,
                        expand: true,
                        ellipsize: true,
                        styleClass: 'cricket-grid-cell cricket-grid-team',
                    },
                    {text: String(batter.runs), width: 32, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(batter.balls), width: 32, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(batter.fours), width: 28, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(batter.sixes), width: 28, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(batter.strikeRate), width: 44, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: batter.thisBowler || '—', width: 72, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-muted'},
                    {text: batter.lastTen || '—', width: 72, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-muted'},
                ]);
            }
        }

        // Bowlers
        if (sc.bowlers?.length) {
            addSectionTitle(menu, 'Bowlers');
            addGridRow(menu, [
                {text: 'Bowler', expand: true, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: 'O', width: 36, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: 'M', width: 28, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: 'R', width: 32, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: 'W', width: 28, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: 'Econ', width: 44, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: 'This spell', width: 110, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
            ], {header: true});

            for (const bowler of sc.bowlers.slice(0, 2)) {
                addGridRow(menu, [
                    {
                        text: truncateName(bowler.name, 18),
                        expand: true,
                        ellipsize: true,
                        styleClass: bowler.isCurrent
                            ? 'cricket-grid-cell cricket-grid-team'
                            : 'cricket-grid-cell',
                    },
                    {text: String(bowler.overs), width: 36, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(bowler.maidens), width: 28, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(bowler.conceded), width: 32, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(bowler.wickets), width: 28, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(bowler.economy), width: 44, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: bowler.thisSpell || '—', width: 110, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-muted'},
                ]);
            }
        }

        this._addOversStrip(menu, sc.overs || []);

        if (sc.partnership) {
            const p = sc.partnership;
            const bits = [`Partnership: ${p.runs ?? 0} Runs`];
            if (p.overs != null)
                bits.push(`${p.overs} Ov`);
            else if (p.balls != null)
                bits.push(`${p.balls} B`);
            if (p.runRate != null)
                bits.push(`RR: ${p.runRate}`);
            addStaticLine(menu, bits.join(', '), 'cricket-scorecard-muted');
        }

        if (sc.lastBat)
            addStaticLine(menu, `Last Bat: ${sc.lastBat}`, 'cricket-scorecard-muted');
        if (sc.fow)
            addStaticLine(menu, `FOW: ${sc.fow}`, 'cricket-scorecard-muted');

        if (sc.reviews?.length) {
            const text = sc.reviews
                .map(r => `${r.team} ${r.remaining}/${r.permitted}`)
                .join(', ');
            addStaticLine(menu, `Reviews remaining: ${text}`, 'cricket-scorecard-muted');
        }

        if (!sc.teams?.length && !sc.batters?.length && !sc.bowlers?.length)
            addStaticLine(menu, 'Live summary unavailable', 'cricket-scorecard-muted');
    }

    _addOversStrip(menu, overs) {
        if (!overs?.length)
            return;

        addSectionTitle(menu, 'Recent overs');

        const row = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'cricket-overs-row',
        });

        const strip = new St.BoxLayout({
            style_class: 'cricket-overs-strip',
            x_expand: true,
        });

        // Layout: [current balls] | 12th 9 RUNS [balls] | 11th ...
        for (let i = 0; i < overs.length; i++) {
            const over = overs[i];
            const balls = i === 0 ? [...over.balls].reverse() : over.balls;

            if (i > 0) {
                const meta = new St.BoxLayout({
                    vertical: true,
                    style_class: 'cricket-over-meta',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                meta.add_child(new St.Label({
                    text: overOrdinal(over.number),
                    style_class: 'cricket-over-number',
                }));
                meta.add_child(new St.Label({
                    text: `${over.runs} RUNS`,
                    style_class: 'cricket-over-runs',
                }));
                strip.add_child(meta);
            }

            const ballsBox = new St.BoxLayout({style_class: 'cricket-over-balls'});
            for (const ball of balls) {
                ballsBox.add_child(new St.Label({
                    text: ball.label,
                    style_class: `cricket-ball cricket-ball-${ball.kind}`,
                }));
            }
            strip.add_child(ballsBox);
        }

        row.add_child(strip);
        menu.addMenuItem(row);
    }

    _setActiveTab(tab) {
        if (this._activeTab === tab)
            return;
        this._activeTab = tab;
        if (this._matches.length)
            this._rebuildMenu(this._matches);
    }

    _addTabBar(menu) {
        const row = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const tabs = new St.BoxLayout({
            style_class: 'cricket-tabs',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });

        const makeTab = (id, label) => {
            const btn = new St.Button({
                label,
                toggle_mode: true,
                checked: this._activeTab === id,
                style_class: 'cricket-tab',
                x_expand: true,
                can_focus: true,
            });
            if (this._activeTab === id)
                btn.add_style_class_name('cricket-tab-active');

            btn.connect('clicked', () => {
                this._setActiveTab(id);
            });
            return btn;
        };

        tabs.add_child(makeTab('live', 'Live'));
        tabs.add_child(makeTab('matches', 'Matches'));
        row.add_child(tabs);
        menu.addMenuItem(row);
    }

    // Keep header/tabs/footer fixed; scroll only the tall content so
    // bottom actions stay reachable when many matches are listed.
    _addScrollableSection(menu, fillSection) {
        const scrollView = new St.ScrollView({
            style_class: 'cricket-menu-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        const monitorHeight = Main.layoutManager.primaryMonitor?.height ?? 900;
        const maxHeight = Math.max(220, Math.floor(monitorHeight * 0.45));
        scrollView.style = `max-height: ${maxHeight}px;`;

        const section = new PopupMenu.PopupMenuSection();
        fillSection(section);
        scrollView.add_child(section.box);

        const wrapper = new PopupMenu.PopupMenuSection();
        wrapper.box.add_child(scrollView);
        menu.addMenuItem(wrapper);
    }

    _addMatchesToMenu(menu, matches) {
        const selectedId = this._settings?.get_string('selected-match-id') || '';

        addStaticLine(
            menu,
            selectedId
                ? 'Click the selected match again to show icon only'
                : 'Click a match to show its score on the panel',
            'cricket-scorecard-muted'
        );

        const liveMatches = matches.filter(m => m.isLive);
        const otherMatches = matches.filter(m => !m.isLive);
        const ordered = [...liveMatches, ...otherMatches].slice(0, 12);

        if (!ordered.length) {
            addStaticLine(menu, 'No matches available', 'cricket-scorecard-muted');
            return;
        }

        this._addScrollableSection(menu, section => {
            for (const matchData of ordered) {
                section.addMenuItem(new MatchMenuItem(matchData, {
                    selected: matchData.id === selectedId,
                    onSelect: id => this._selectMatch(id),
                }));
            }
        });
    }

    _addFooterActions(menu, selected) {
        const selectedId = this._settings?.get_string('selected-match-id') || '';

        if (selected?.link) {
            const openItem = new PopupMenu.PopupMenuItem('Open selected in browser');
            openItem.connect('activate', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(selected.link, null);
                } catch (e) {
                    console.error(`[gnome-cricket-score] Could not open URI: ${e.message}`);
                }
            });
            menu.addMenuItem(openItem);
        }

        if (selectedId) {
            const clearItem = new PopupMenu.PopupMenuItem('Clear selection (icon only)');
            clearItem.connect('activate', () => this._clearSelectedMatch());
            menu.addMenuItem(clearItem);
        }

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh Now');
        refreshItem.connect('activate', () => this._manualRefresh());
        menu.addMenuItem(refreshItem);
    }

    _rebuildMenu(matches) {
        if (!this._indicator)
            return;

        const menu = this._indicator.menu;
        const wasOpen = menu.isOpen;
        menu.removeAll();

        // Wide enough for live summary columns
        const minWidth = this._activeTab === 'live' ? 600 : 360;
        if (menu.box) {
            menu.box.style = `min-width: ${minWidth}px;`;
            menu.box.add_style_class_name('cricket-scorecard-menu');
        }

        const selected = this._getSelectedMatch(matches);

        const now = new Date();
        const timeStr = now.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        menu.addMenuItem(new PopupMenu.PopupMenuItem(
            `Last updated: ${timeStr}`,
            {reactive: false}
        ));

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addTabBar(menu);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (this._activeTab === 'matches') {
            this._addMatchesToMenu(menu, matches);
        } else {
            this._addScrollableSection(menu, section => {
                this._addScorecardToMenu(section, selected);
            });
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addFooterActions(menu, selected);

        if (wasOpen && !menu.isOpen)
            menu.open();
    }

    _processMatches(matches) {
        if (!this._indicator)
            return;

        this._matches = matches;

        if (matches.length === 0) {
            this._scorecard = null;
            this._scorecardMatchKey = '';
            this._updatePanelDisplay(null);
            if (!this._indicator.menu.isOpen)
                this._rebuildMenu([]);
            return;
        }

        const selected = this._getSelectedMatch(matches);
        this._updatePanelDisplay(selected);

        if (selected)
            this._fetchScorecard(selected);
        else {
            this._scorecard = null;
            this._scorecardMatchKey = '';
        }

        if (!this._indicator.menu.isOpen)
            this._rebuildMenu(matches);
    }

    _httpGet(url, callback) {
        const message = Soup.Message.new('GET', url);

        if (!message) {
            callback(new Error('Could not create request'), null);
            return;
        }

        // Minimal set that succeeds against ESPN (curl/Soup): browser UA + Accept.
        // Also set session.user_agent in enable(); replace avoids duplicate UA headers.
        const headers = message.get_request_headers();
        headers.replace('User-Agent', ESPN_USER_AGENT);
        headers.replace('Accept', 'application/json');

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const statusCode = message.get_status();
                    if (statusCode !== Soup.Status.OK) {
                        let snippet = '';
                        try {
                            snippet = new TextDecoder('utf-8').decode(bytes.get_data()).slice(0, 180);
                        } catch (_e) {}
                        console.error(`[gnome-cricket-score] HTTP ${statusCode} for ${url}: ${snippet}`);
                        callback(new Error(`HTTP ${statusCode}`), null);
                        return;
                    }
                    const decoder = new TextDecoder('utf-8');
                    const text = decoder.decode(bytes.get_data());
                    callback(null, JSON.parse(text));
                } catch (err) {
                    callback(err, null);
                }
            }
        );
    }

    // ESPN play-by-play is paginated oldest-first. Page 1 is early balls, so
    // we must load the last page(s) or the overs strip freezes mid-innings.
    _fetchLatestPlayByPlay(match, callback) {
        const limit = 50;
        const base = {limit};

        this._httpGet(playByPlayUrl(match.leagueId, match.id, base), (err, data) => {
            if (err || !data?.commentary) {
                callback(err, data);
                return;
            }

            const pageCount = Number(data.commentary.pageCount) || 1;
            if (pageCount <= 1) {
                callback(null, data);
                return;
            }

            // Last two pages so current + previous overs are complete
            const pages = [Math.max(1, pageCount - 1), pageCount];
            let pending = pages.length;
            const byPage = new Map();

            for (const page of pages) {
                this._httpGet(
                    playByPlayUrl(match.leagueId, match.id, {limit, page}),
                    (pageErr, pageData) => {
                        if (pageErr)
                            console.error(`[gnome-cricket-score] Play-by-play page ${page}: ${pageErr.message}`);
                        byPage.set(page, pageData?.commentary?.items || []);
                        pending -= 1;
                        if (pending > 0)
                            return;

                        const items = [];
                        const seen = new Set();
                        for (const p of pages) {
                            for (const item of byPage.get(p) || []) {
                                const id = item.id ?? item.over?.unique ?? JSON.stringify(item.over);
                                if (seen.has(id))
                                    continue;
                                seen.add(id);
                                items.push(item);
                            }
                        }
                        callback(null, {commentary: {items, pageCount, count: items.length}});
                    }
                );
            }
        });
    }

    _fetchScorecard(match) {
        if (!this._session || !match?.leagueId || !match?.id)
            return;

        const key = this._matchKey(match);
        if (this._scorecardFetchInFlight && this._scorecardMatchKey === key) {
            this._scorecardRefreshQueued = true;
            return;
        }

        this._scorecardFetchInFlight = true;
        this._scorecardRefreshQueued = false;
        this._scorecardMatchKey = key;

        let pending = 2;
        let summaryData = null;
        let playData = null;
        let summaryErr = null;

        const finish = () => {
            pending -= 1;
            if (pending > 0)
                return;

            this._scorecardFetchInFlight = false;

            if (!this._indicator)
                return;

            const selected = this._getSelectedMatch(this._matches);
            if (!selected || this._matchKey(selected) !== key)
                return;

            if (summaryErr || !summaryData) {
                console.error(`[gnome-cricket-score] Scorecard error: ${summaryErr?.message || 'empty'}`);
                this._scorecard = null;
                this._rebuildMenu(this._matches);
                if (this._scorecardRefreshQueued)
                    this._fetchScorecard(selected);
                return;
            }

            this._scorecard = this._parseScorecard(summaryData);
            if (this._scorecard) {
                this._scorecard.overs = this._parseOvers(playData);

                // Scoreboard header is often fresher for delay badges than summary.
                const headerStatus = selected.playStatus || '';
                if (headerStatus && headerStatus !== 'LIVE')
                    this._scorecard.playStatus = headerStatus;
                else if (!this._scorecard.playStatus)
                    this._scorecard.playStatus = headerStatus || 'LIVE';
            }

            if (this._scorecard?.teams?.length >= 2) {
                const panelText = this._scorecard.teams.map(t => {
                    const name = t.abbr || t.name || '?';
                    return t.score ? `${name} ${t.score}` : name;
                }).join(' v ');
                this._updatePanelDisplay({
                    ...selected,
                    panelText,
                });
            }

            this._rebuildMenu(this._matches);

            if (this._scorecardRefreshQueued)
                this._fetchScorecard(selected);
        };

        this._httpGet(summaryUrl(match.leagueId, match.id), (err, data) => {
            summaryErr = err;
            summaryData = data;
            finish();
        });

        this._fetchLatestPlayByPlay(match, (err, data) => {
            if (err)
                console.error(`[gnome-cricket-score] Play-by-play error: ${err.message}`);
            playData = data;
            finish();
        });
    }

    _fetchScore() {
        if (!this._session || !this._indicator || this._fetchInFlight)
            return;

        this._fetchInFlight = true;

        this._httpGet(API_URL, (err, apiData) => {
            this._fetchInFlight = false;

            if (!this._indicator)
                return;

            if (err) {
                console.error(`[gnome-cricket-score] Request error: ${err.message}`);
                this._buildFallbackMenu('Unable to load matches');
                return;
            }

            const matches = this._parseApiData(apiData);
            this._processMatches(matches);
        });
    }
}
