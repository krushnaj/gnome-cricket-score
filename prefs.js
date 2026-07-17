// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CricketScorePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('gnome-cricket-score'),
            description: _('Configure how live scores appear in the top panel.'),
        });
        page.add(group);

        const refreshRow = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('Seconds between polls (default 10)'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 900,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind(
            'refresh-interval',
            refreshRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(refreshRow);

        const positionRow = new Adw.ComboRow({
            title: _('Panel position'),
            subtitle: _('Where to place the indicator on the top panel'),
        });
        positionRow.model = new Gtk.StringList({
            strings: [_('Left'), _('Center'), _('Right')],
        });

        const positions = ['left', 'center', 'right'];
        const current = settings.get_string('panel-position') || 'center';
        positionRow.selected = Math.max(0, positions.indexOf(current));

        positionRow.connect('notify::selected', () => {
            const idx = positionRow.selected;
            if (idx >= 0 && idx < positions.length)
                settings.set_string('panel-position', positions[idx]);
        });

        settings.connect('changed::panel-position', () => {
            const value = settings.get_string('panel-position') || 'center';
            const idx = positions.indexOf(value);
            if (idx >= 0 && positionRow.selected !== idx)
                positionRow.selected = idx;
        });

        group.add(positionRow);
    }
}
