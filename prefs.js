import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SpatialOverviewPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Animation',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Animation Timing',
            description: 'Adjust the speed and curve of workspace zoom animations',
        });
        page.add(group);

        const zoomOutRow = new Adw.SpinRow({
            title: 'Zoom-out Duration',
            subtitle: 'Duration in milliseconds for the zoom-out animation',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 2000,
                step_increment: 10,
                page_increment: 100,
                value: settings.get_uint('zoom-out-duration'),
            }),
        });
        group.add(zoomOutRow);
        settings.bind('zoom-out-duration', zoomOutRow.adjustment, 'value',
            Gio.SettingsBindFlags.DEFAULT);

        const zoomInRow = new Adw.SpinRow({
            title: 'Zoom-in Duration',
            subtitle: 'Duration in milliseconds for the zoom-in animation',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 2000,
                step_increment: 10,
                page_increment: 100,
                value: settings.get_uint('zoom-in-duration'),
            }),
        });
        group.add(zoomInRow);
        settings.bind('zoom-in-duration', zoomInRow.adjustment, 'value',
            Gio.SettingsBindFlags.DEFAULT);

        const holdRow = new Adw.SpinRow({
            title: 'Zoom-out Hold Delay',
            subtitle: 'Milliseconds to hold before engaging spatial layout. 0 disables the hold.',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 5000,
                step_increment: 10,
                page_increment: 100,
                value: settings.get_uint('zoom-out-hold-delay'),
            }),
        });
        group.add(holdRow);
        settings.bind('zoom-out-hold-delay', holdRow.adjustment, 'value',
            Gio.SettingsBindFlags.DEFAULT);

        const easingStore = new Gtk.StringList({
            strings: [
                'Ease Out Quad',
                'Ease Out Cubic',
                'Ease Out Expo',
                'Ease Out Back',
            ],
        });
        const easingRow = new Adw.ComboRow({
            title: 'Zoom Easing',
            subtitle: 'Easing curve applied to both zoom-in and zoom-out animations',
            model: easingStore,
        });
        group.add(easingRow);

        const EASING_VALUES = [
            'ease-out-quad',
            'ease-out-cubic',
            'ease-out-expo',
            'ease-out-back',
        ];
        easingRow.connect('notify::selected', row => {
            const idx = row.selected;
            if (idx >= 0 && idx < EASING_VALUES.length)
                settings.set_string('zoom-easing', EASING_VALUES[idx]);
        });
        const currentVal = settings.get_string('zoom-easing');
        const initialIdx = EASING_VALUES.indexOf(currentVal);
        if (initialIdx >= 0)
            easingRow.selected = initialIdx;
    }
}
