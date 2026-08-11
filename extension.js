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

    _playerInningsStats(player) {
        for (const period of player.linescores || []) {
            for (const ls of period.linescores || []) {
                const st = ls.statistics || {};
                const map = this._statsMap(st);
                if (Object.keys(map).length)
                    return {map, batting: st.batting || null, bowling: st.bowling || null};
            }
        }
        return {map: this._statsMap(player.statistics), batting: null, bowling: null};
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

        // Current innings linescore (batting side)
        let battingLinescore = null;
        for (const team of teams) {
            for (const ls of team.linescores || []) {
                if (ls.isBatting || Number(ls.isCurrent) === 1) {
                    if (ls.isBatting)
                        battingLinescore = {...ls, teamAbbr: team.abbr, teamName: team.name};
                } else if (Number(ls.isCurrent) === 0 && !ls.isBatting) {
                    // fielding side in current period
                }
            }
        }
        if (!battingLinescore) {
            for (const team of teams) {
                for (const ls of team.linescores || []) {
                    if (ls.isBatting) {
                        battingLinescore = {...ls, teamAbbr: team.abbr, teamName: team.name};
                        break;
                    }
                }
                if (battingLinescore)
                    break;
            }
        }

        const partnerships = battingLinescore?.partnerships || [];
        const currentPartnership = partnerships.length
            ? partnerships[partnerships.length - 1]
            : null;

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

        for (const roster of apiData.rosters || []) {
            const teamAbbr = roster?.team?.abbreviation || roster?.team?.displayName || '';
            for (const player of roster.roster || []) {
                const athlete = player.athlete || {};
                const {map, batting, bowling} = this._playerInningsStats(player);
                const name = athlete.displayName || athlete.shortName || athlete.name || '?';

                // Current / recent batters
                if (String(map.batted) === '1') {
                    const dismissal = map.dismissalCard || '';
                    const isNotOut = dismissal === 'not out' || dismissal === '';
                    if (player.active || isNotOut) {
                        const pvp = batting?.pvp || {};
                        const recent = batting?.battingRecent || {};
                        const role = (player.activeName || '').toLowerCase();
                        batters.push({
                            name,
                            team: teamAbbr,
                            active: !!player.active,
                            role,
                            isStriker: role.includes('striker') && !role.includes('non'),
                            runs: map.runs ?? '0',
                            balls: map.ballsFaced ?? '0',
                            fours: map.fours ?? '0',
                            sixes: map.sixes ?? '0',
                            strikeRate: map.strikeRate ?? '-',
                            thisBowler: (pvp.runs != null && pvp.balls != null)
                                ? `${pvp.runs}(${pvp.balls})`
                                : '',
                            lastFive: (recent.runs != null && recent.balls != null)
                                ? `${recent.runs}(${recent.balls})`
                                : '',
                        });
                    }
                }

                // Bowlers who have bowled
                if (map.overs != null) {
                    const overs = String(map.overs);
                    if (overs && overs !== '0' && overs !== '0.0' && overs !== '-') {
                        const spell = bowling?.currentSpell || {};
                        const role = (player.activeName || '').toLowerCase();
                        bowlers.push({
                            name,
                            team: teamAbbr,
                            active: !!player.active,
                            isCurrent: role.includes('current bowler') || role.includes('bowler'),
                            overs: map.overs ?? '0',
                            maidens: map.maidens ?? '0',
                            conceded: map.conceded ?? '0',
                            wickets: map.wickets ?? '0',
                            economy: map.economyRate ?? '-',
                            dots: map.dots ?? '',
                            thisSpell: spell.overs != null
                                ? `${spell.overs}-${spell.maidens ?? 0}-${spell.conceded ?? 0}-${spell.wickets ?? 0}`
                                : '',
                        });
                    }
                }
            }
        }

        // Prefer striker/non-striker order for batters
        batters.sort((a, b) => {
            if (a.isStriker !== b.isStriker)
                return a.isStriker ? -1 : 1;
            if (a.active !== b.active)
                return a.active ? -1 : 1;
            return 0;
        });

        // Current bowler first
        bowlers.sort((a, b) => {
            if (a.isCurrent !== b.isCurrent)
                return a.isCurrent ? -1 : 1;
            if (a.active !== b.active)
                return a.active ? -1 : 1;
            return 0;
        });

        const runs = battingLinescore?.runs;
        const overs = battingLinescore?.overs;
        let runRate = '';
        if (currentPartnership?.runRate != null)
            runRate = String(currentPartnership.runRate);
        else if (runs != null && overs != null && Number(overs) > 0) {
            const o = Number(overs);
            const whole = Math.floor(o);
            const balls = Math.round((o - whole) * 10);
            const totalBalls = whole * 6 + balls;
            if (totalBalls > 0)
                runRate = (Number(runs) * 6 / totalBalls).toFixed(2);
        }

        if (!teams.length && !batters.length && !bowlers.length)
            return null;

        return {
            summary: status.summary || '',
            session: status.session || '',
            displayPeriod: status.displayPeriod || '',
            statusText: statusType.description || statusType.detail || '',
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
            battingScore: battingLinescore?.score || '',
            battingTeam: battingLinescore?.teamAbbr || battingLinescore?.teamName || '',
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

        // Header: batting team score prominently, then other team
        const battingTeam = sc.teams.find(t =>
            t.abbr === sc.battingTeam || t.name === sc.battingTeam
        ) || sc.teams.find(t => (t.score || '').length > 0) || sc.teams[0];
        const otherTeams = sc.teams.filter(t => t !== battingTeam);

        if (battingTeam) {
            addGridRow(menu, [
                {
                    text: battingTeam.abbr || battingTeam.name,
                    expand: true,
                    styleClass: 'cricket-grid-cell cricket-grid-team',
                },
                {
                    text: battingTeam.score || sc.battingScore || '—',
                    width: 130,
                    align: Clutter.ActorAlign.END,
                    styleClass: 'cricket-grid-cell cricket-grid-score',
                },
            ]);
        }
        for (const team of otherTeams) {
            addGridRow(menu, [
                {
                    text: team.abbr || team.name,
                    expand: true,
                    styleClass: 'cricket-grid-cell',
                },
                {
                    text: team.score || 'yet to bat',
                    width: 130,
                    align: Clutter.ActorAlign.END,
                    styleClass: 'cricket-grid-cell cricket-grid-muted',
                },
            ]);
        }

        const meta = [];
        if (sc.toss)
            meta.push(sc.toss.replace(/\s+/g, ' '));
        if (sc.runRate)
            meta.push(`Current RR: ${sc.runRate}`);
        if (meta.length)
            addStaticLine(menu, meta.join(' · '), 'cricket-scorecard-muted');

        if (sc.summary)
            addStaticLine(menu, sc.summary, 'cricket-scorecard-muted');

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
                {text: 'Vs bowl', width: 56, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
                {text: 'Last 5', width: 52, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
            ], {header: true});

            for (const batter of sc.batters.slice(0, 4)) {
                const mark = batter.isStriker ? '*' : '';
                addGridRow(menu, [
                    {
                        text: `${truncateName(batter.name, 16)}${mark}`,
                        expand: true,
                        ellipsize: true,
                        styleClass: batter.active
                            ? 'cricket-grid-cell cricket-grid-team'
                            : 'cricket-grid-cell',
                    },
                    {text: String(batter.runs), width: 32, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(batter.balls), width: 32, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(batter.fours), width: 28, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(batter.sixes), width: 28, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(batter.strikeRate), width: 44, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: batter.thisBowler || '—', width: 56, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-muted'},
                    {text: batter.lastFive || '—', width: 52, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-muted'},
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
                {text: 'This spell', width: 90, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-header'},
            ], {header: true});

            for (const bowler of sc.bowlers.slice(0, 4)) {
                addGridRow(menu, [
                    {
                        text: truncateName(bowler.name, 16),
                        expand: true,
                        ellipsize: true,
                        styleClass: bowler.isCurrent || bowler.active
                            ? 'cricket-grid-cell cricket-grid-team'
                            : 'cricket-grid-cell',
                    },
                    {text: String(bowler.overs), width: 36, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(bowler.maidens), width: 28, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(bowler.conceded), width: 32, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(bowler.wickets), width: 28, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: String(bowler.economy), width: 44, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-num'},
                    {text: bowler.thisSpell || '—', width: 90, align: Clutter.ActorAlign.END, styleClass: 'cricket-grid-cell cricket-grid-muted'},
                ]);
            }
        }

        this._addOversStrip(menu, sc.overs || []);

        // Footer: partnership + reviews
        if (sc.partnership) {
            const p = sc.partnership;
            const bits = [`Partnership: ${p.runs ?? 0} runs`];
            if (p.balls != null)
                bits.push(`${p.balls} B`);
            else if (p.overs != null)
                bits.push(`${p.overs} ov`);
            if (p.runRate != null)
                bits.push(`RR: ${p.runRate}`);
            addStaticLine(menu, bits.join(', '), 'cricket-scorecard-muted');
        }

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

        for (const matchData of ordered) {
            menu.addMenuItem(new MatchMenuItem(matchData, {
                selected: matchData.id === selectedId,
                onSelect: id => this._selectMatch(id),
            }));
        }
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

        if (this._activeTab === 'matches')
            this._addMatchesToMenu(menu, matches);
        else
            this._addScorecardToMenu(menu, selected);

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
            if (this._scorecard)
                this._scorecard.overs = this._parseOvers(playData);

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
