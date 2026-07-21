import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ZOOM_OUT_DURATION = 500;
const ZOOM_IN_DURATION = 350;
const BACKDROP_OPACITY = 55;
const FIT_ALL = 1;
const FIT_SINGLE = 0;

const ZoomOutView = GObject.registerClass({
    Signals: {
        'workspace-activated': {param_types: [GObject.TYPE_INT]},
    },
}, class ZoomOutView extends St.Widget {
    _init() {
        super._init({
            reactive: false,
            visible: false,
            x: 0,
            y: 0,
            x_expand: true,
            y_expand: true,
        });

        this._progressAdj = new St.Adjustment({
            actor: this,
            value: 0,
            lower: 0,
            upper: 1,
        });

        this._backdrop = new St.Widget({
            style_class: 'zoom-out-backdrop',
            reactive: false,
            opacity: 0,
        });
        this.add_child(this._backdrop);
    }

    show() {
        this.visible = true;
        this._progressAdj.ease(1, {
            duration: ZOOM_OUT_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    hide() {
        this._progressAdj.ease(0, {
            duration: ZOOM_IN_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.visible = false;
            },
        });
    }

    updateProgress(value) {
        const p = Math.min(Math.max(value, 0), 1);
        this._backdrop.opacity = Math.round(p * BACKDROP_OPACITY);
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const [width, height] = box.get_size();

        const backdropBox = new Clutter.ActorBox();
        backdropBox.set_origin(0, 0);
        backdropBox.set_size(width, height);
        this._backdrop.allocate(backdropBox);
    }

    vfunc_get_preferred_width(forHeight) {
        const mon = Main.layoutManager.monitors[
            Main.layoutManager.primaryIndex];
        return [0, mon ? mon.width : 1920];
    }

    vfunc_get_preferred_height(forWidth) {
        const mon = Main.layoutManager.monitors[
            Main.layoutManager.primaryIndex];
        return [0, mon ? mon.height : 1080];
    }
});

export default class SpatialWorkspaceExtension extends Extension {
    enable() {
        this._dragActive = false;
        this._originalUpdate = null;
        this._dragBeginId = null;
        this._dragEndId = null;
        this._dragCancelledId = null;
        this._progressSignalId = null;

        this._zoomOutView = new ZoomOutView();
        Main.layoutManager.overviewGroup.add_child(this._zoomOutView);

        this._overrideThumbnailsShouldShow();

        this._progressSignalId = this._zoomOutView._progressAdj.connect(
            'notify::value', () => {
                const p = this._zoomOutView._progressAdj.value;
                this._zoomOutView?.updateProgress(p);
                this._animateDash(p);
                this._animateSearch(p);
            });

        this._dragBeginId = Main.overview.connect(
            'window-drag-begin', this._onDragBegin.bind(this));
        this._dragEndId = Main.overview.connect(
            'window-drag-end', this._onDragEnd.bind(this));
        this._dragCancelledId = Main.overview.connect(
            'window-drag-cancelled', this._onDragEnd.bind(this));
    }

    disable() {
        if (this._dragActive)
            this._onDragEnd();

        this._restoreThumbnailsShouldShow();

        if (this._progressSignalId && this._zoomOutView) {
            this._zoomOutView._progressAdj.disconnect(this._progressSignalId);
            this._progressSignalId = null;
        }

        if (this._dragBeginId) {
            Main.overview.disconnect(this._dragBeginId);
            this._dragBeginId = null;
        }
        if (this._dragEndId) {
            Main.overview.disconnect(this._dragEndId);
            this._dragEndId = null;
        }
        if (this._dragCancelledId) {
            Main.overview.disconnect(this._dragCancelledId);
            this._dragCancelledId = null;
        }

        this._restoreControlsUpdate();
        this._dragActive = false;
        this._resetDash();
        this._resetSearch();

        if (this._zoomOutView) {
            this._zoomOutView.destroy();
            this._zoomOutView = null;
        }
    }

    _onDragBegin() {
        this._dragActive = true;

        const controls = this._getControls();
        if (controls) {
            this._overrideControlsUpdate(controls);

            const ws = controls._workspacesDisplay;
            if (ws?._fitModeAdjustment) {
                ws._fitModeAdjustment.ease(FIT_ALL, {
                    duration: ZOOM_OUT_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }

            for (const view of ws._workspacesViews ?? []) {
                for (const w of view._workspaces ?? [])
                    w.reactive = true;
            }
        }

        if (this._zoomOutView)
            this._zoomOutView.show();
    }

    _onDragEnd() {
        if (!this._dragActive)
            return;

        this._dragActive = false;
        this._restoreControlsUpdate();

        const ws = this._getWsDisplay();
        if (ws?._fitModeAdjustment) {
            ws._fitModeAdjustment.ease(FIT_SINGLE, {
                duration: ZOOM_IN_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        if (ws) {
            for (const view of ws._workspacesViews ?? []) {
                for (const w of view._workspaces ?? [])
                    w.reactive = true;
            }
        }

        if (this._zoomOutView)
            this._zoomOutView.hide();
    }

    _overrideThumbnailsShouldShow() {
        const box = this._getThumbnailsBox();
        if (!box)
            return;

        this._originalShouldShow = box._updateShouldShow;
        box._updateShouldShow = () => {
            const shouldShow = false;
            if (box._shouldShow === shouldShow)
                return;
            box._shouldShow = shouldShow;
            box.notify('should-show');
        };
        box._updateShouldShow();
    }

    _restoreThumbnailsShouldShow() {
        const box = this._getThumbnailsBox();
        if (box && this._originalShouldShow) {
            box._updateShouldShow = this._originalShouldShow;
            box._updateShouldShow();
        }
        this._originalShouldShow = null;
    }

    _getThumbnailsBox() {
        return Main.overview?._overview?.controls?._thumbnailsBox ?? null;
    }

    _animateDash(progress) {
        const dash = Main.overview?.dash;
        if (!dash)
            return;

        const dashHeight = dash.height || 100;
        dash.translation_y = Math.round(progress * dashHeight);
        dash.opacity = Math.round((1 - progress) * 255);
    }

    _resetDash() {
        const dash = Main.overview?.dash;
        if (!dash)
            return;
        dash.translation_y = 0;
        dash.opacity = 255;
    }

    _animateSearch(progress) {
        const entry = Main.overview?._overview?.controls?._searchController?._entry;
        if (!entry)
            return;

        const entryHeight = entry.height || 50;
        entry.translation_y = Math.round(-progress * entryHeight);
        entry.opacity = Math.round((1 - progress) * 255);
    }

    _resetSearch() {
        const entry = Main.overview?._overview?.controls?._searchController?._entry;
        if (!entry)
            return;
        entry.translation_y = 0;
        entry.opacity = 255;
    }

    _overrideControlsUpdate(controls) {
        if (this._originalUpdate)
            return;

        this._originalUpdate = controls._update.bind(controls);
        const self = this;

        controls._update = function () {
            self._originalUpdate.call(this);

            if (self._dragActive) {
                const ws = this._workspacesDisplay;
                if (ws?._fitModeAdjustment)
                    ws._fitModeAdjustment.value = FIT_ALL;
            }
        };
    }

    _restoreControlsUpdate() {
        if (!this._originalUpdate)
            return;

        const controls = this._getControls();
        if (controls)
            controls._update = this._originalUpdate;

        this._originalUpdate = null;
    }

    _getControls() {
        return Main.overview?._overview?.controls ?? null;
    }

    _getWsDisplay() {
        return this._getControls()?._workspacesDisplay ?? null;
    }
}
