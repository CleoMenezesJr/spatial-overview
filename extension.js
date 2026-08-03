// Proof of concept. A pile of shitty monkey-patches whose only real purpose
// is to document possible upstream changes - see the `FIXME downstream`
// comments. Don't read the rest.

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import {FitMode, WorkspacesView} from 'resource:///org/gnome/shell/ui/workspacesView.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';
import {HotCorner} from 'resource:///org/gnome/shell/ui/layout.js';
import {WindowPreview} from 'resource:///org/gnome/shell/ui/windowPreview.js';
import {WorkspaceLayout} from 'resource:///org/gnome/shell/ui/workspace.js';

const TAG = '[SPATIAL-WS]';
const DEBUG = GLib.getenv('SPATIAL_WS_DEBUG') !== null;
const logTime = DEBUG
    ? (...a) => console.log(TAG, `t=${Date.now() % 100000}`, ...a)
    : () => {};
const ZOOM_OUT_DURATION = 210;
const ZOOM_IN_DURATION = 400;
// Shorter than ZOOM_IN_DURATION: this zoom-in has the overview's own leave
// animation queued behind it.
const ZOOM_IN_ACTIVATE_DURATION = 200;
const ZOOM_OUT_HOLD_DELAY = 150;
const BACKDROP_OPACITY = 180;
const MIN_WS_SCALE = 0.18;
// Gap between fit-all workspaces, as a fraction of a workspace's own size.
// Upstream's ALL-mode spacing is a flat WORKSPACE_MIN_SPACING (24px,
// workspacesView.js:22,224) that does not follow the shrinking workspaces.
const WORKSPACE_GAP_RATIO = 0.006;
// Upstream emphasises the current workspace by shrinking every other one to
// WORKSPACE_INACTIVE_SCALE (0.94, workspacesView.js:25). Same 6% difference,
// anchored the other way round: the row sits at 1 and the current one grows,
// so the emphasis spends the gap instead of leaving a hole beside every panel.
const WORKSPACE_ACTIVE_SCALE = 1.06;
const WORKSPACE_CUT_SIZE = 10; // workspaceThumbnail.js:27
const MIN_WORKSPACES = 3;
const WORKSPACE_DOT_DURATION = 500; // panel.js:114,125
// Fraction of the monitor the centered hot zone spans. The size layout.js
// passes in (panelBox.height) no longer sets the width, only whether there is
// a barrier at all: HotCorner._onDestroy tears it down by calling
// setBarrierSize(0) (layout.js:1238-1239).
const HOT_EDGE_WIDTH_FRACTION = 1 / 3;
const PLACEHOLDER_WIDTH = 24;

const ZoomOutView = GObject.registerClass({
    Signals: {
        'workspace-activated': {param_types: [GObject.TYPE_INT]},
    },
}, class ZoomOutView extends St.Widget {
    _init() {
        super._init({
            reactive: true,
            visible: false,
            x: 0,
            y: 0,
            x_expand: true,
            y_expand: true,
        });

        this._delegate = this;
        this._extension = null;

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

        // FIXME downstream: replica of the upstream ThumbnailsBox
        // _dropPlaceholder (workspaceThumbnail.js:613). Used to signal
        // "drop here creates a new workspace" in FitMode.ALL.
        //
        // Ours is an overlay; upstream allocates its placeholder into the row
        // so the workspaces visibly open a gap. WorkspacesView.vfunc_allocate
        // advances every workspace by one uniform spacing
        // (workspacesView.js:371-386), leaving no per-gap room to allocate
        // into. Translating the actors instead was tried and reverted: the
        // hit test reads get_transformed_position, so the zone moved with the
        // animation and escaped the cursor every frame. Doing it properly
        // needs the fit-all loop to consult a placeholder position the way
        // ThumbnailsBox does - which is the upstream change worth asking for.
        this._dropPlaceholder = new St.Bin({
            style_class: 'placeholder',
            visible: false,
            reactive: false,
            x: 0,
            y: 0,
        });
        this._dropPlaceholderRect = null; // { x, y, w, h } in ZoomOutView local coords
        this.add_child(this._dropPlaceholder);
    }

    setDropPlaceholderRect(rect) {
        this._dropPlaceholderRect = rect;
        if (rect) {
            this._dropPlaceholder.visible = true;
            this.queue_relayout();
        } else {
            this._dropPlaceholder.visible = false;
        }
    }

    show() {
        logTime('VIEW.show start (zoom-out)');
        this.visible = true;
        this._progressAdj.ease(1, {
            duration: ZOOM_OUT_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    hide() {
        logTime('VIEW.hide start (zoom-in)');
        this._progressAdj.ease(0, {
            duration: ZOOM_IN_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                logTime('VIEW.hide onComplete (zoom-in DONE)');
                this._backdrop.opacity = 0;
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

        if (this._dropPlaceholder && this._dropPlaceholder.visible &&
            this._dropPlaceholderRect) {
            const r = this._dropPlaceholderRect;
            const phBox = new Clutter.ActorBox();
            phBox.set_origin(Math.round(r.x), Math.round(r.y));
            phBox.set_size(Math.max(1, Math.round(r.w)),
                Math.max(1, Math.round(r.h)));
            this._dropPlaceholder.allocate(phBox);
        }
    }

    vfunc_get_preferred_width() {
        const mon = Main.layoutManager.monitors[
            Main.layoutManager.primaryIndex];
        return [0, mon ? mon.width : 1920];
    }

    vfunc_get_preferred_height() {
        const mon = Main.layoutManager.monitors[
            Main.layoutManager.primaryIndex];
        return [0, mon ? mon.height : 1080];
    }

    handleDragOver(source, _dragActor, x, y, _time) {
        if (!this._extension)
            return DND.DragMotionResult.CONTINUE;

        this._extension._lastDragOverX = x;
        this._extension._lastDragOverY = y;

        // FIXME downstream: in GNOME upstream, only the ThumbnailsBox uses
        // _dropPlaceholder + insertWorkspace. We extend the same semantics
        // onto the main WorkspacesView in FitMode.ALL via this extension.
        //
        // Like ThumbnailsBox.handleDragOver (workspaceThumbnail.js:831), this
        // is where the drop target is decided; acceptDrop only consumes it.
        // The two can't be allowed to recompute independently: hover runs off
        // a coalesced idle over motion coordinates (dnd.js:364-370) and its
        // last queued pass is dropped unrun by _dragComplete (dnd.js:545-548),
        // while acceptDrop sees the button-release coordinates (dnd.js:386).
        const isWindow = !!source?.metaWindow;
        this._extension._dropWorkspaceIndex = -1;

        const insertIndex =
            this._extension._getInsertWorkspaceIndex(x, y);
        if (insertIndex >= 0) {
            const rect =
                this._extension._getInsertRect(insertIndex);
            if (rect) {
                this._extension._dropInsertIndex = insertIndex;
                this.setDropPlaceholderRect(rect);
                logTime('VIEW.handleDragOver => INSERT',
                    {insertIndex, x, y, rect});
                return isWindow
                    ? DND.DragMotionResult.MOVE_DROP
                    : DND.DragMotionResult.COPY_DROP;
            }
        }

        // No insert zone: clear placeholder, then try existing-workspace drop.
        this._extension._clearDragPlaceholder();
        const wsIndex = this._extension._getWorkspaceIndexAt(x, y);
        this._extension._dropWorkspaceIndex = wsIndex;
        if (wsIndex < 0) {
            logTime('VIEW.handleDragOver => CONTINUE (wsIndex < 0)', x, y);
            return DND.DragMotionResult.CONTINUE;
        }
        logTime('VIEW.handleDragOver => MOVE_DROP', {wsIndex, x, y});
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, _dragActor, x, y, _time) {
        logTime('VIEW.acceptDrop REACHED', {x, y});
        if (!this._extension)
            return false;
        return this._extension._handleDrop(source, x, y) === true;
    }
});

export default class SpatialOverviewExtension extends Extension {
    enable() {
        this._dragActive = false;
        this._dragMonitor = null;
        this._draggedMetaWindow = null;
        this._dragBeginId = null;
        this._dragEndId = null;
        this._dragCancelledId = null;
        this._overviewHidingId = null;
        this._escapeCapturedId = 0;
        this._progressSignalId = null;
        this._fitModeNotifyId = 0;
        this._fitModeNotifyAdj = null;
        this._restoreIdleId = 0;
        this._engageTimeoutId = 0;
        this._spatialEngaged = false;
        this._dropInsertIndex = -1;
        this._dropWorkspaceIndex = -1;
        this._sessionModeUpdatedId = 0;
        this._minWorkspacesProto = null;
        this._panelPatched = false;
        this._clockIndicatorPad = null;
        this._workspaceDotProto = null;
        this._dotBox = null;
        this._dotLayout = null;
        this._dotOrigSpacing = 0;
        this._dotHalfSpacing = 0;
        this._dotStyleChangedId = 0;
        this._hotCornerPatched = false;

        this._patchPanelLayout();
        this._patchWorkspaceDots();
        this._patchHotCorner();
        this._patchPreviewActivate();
        this._patchFitAllLayout();

        this._zoomOutView = new ZoomOutView();
        this._zoomOutView._extension = this;
        Main.layoutManager.overviewGroup.add_child(this._zoomOutView);

        this._overrideThumbnailsShouldShow();

        this._patchMinWorkspaces();

        this._progressSignalId = this._zoomOutView._progressAdj.connect(
            'notify::value', () => {
                const p = this._zoomOutView._progressAdj.value;
                this._zoomOutView?.updateProgress(p);
            });

        this._dragBeginId = Main.overview.connect(
            'window-drag-begin', (_overview, metaWindow) => {
                this._onDragBegin(metaWindow);
            });
        this._dragEndId = Main.overview.connect(
            'window-drag-end', () => {
                logTime('SIGNAL window-drag-end from overview');
                this._onDragEnd(false);
            });
        this._dragCancelledId = Main.overview.connect(
            'window-drag-cancelled', () => {
                logTime('SIGNAL window-drag-cancelled from overview');
                this._onDragEnd(true);
            });
        // Fit-all now outlives the drag, so it can also outlive the overview:
        // clicking a window preview activates it (workspace.js:1393-1397) and
        // that hides the overview from under us. The leave animation reads the
        // workspace geometry, and in FitMode.ALL that geometry is the shrunken
        // one.
        this._overviewHidingId = Main.overview.connect('hiding', () => {
            if (this._spatialEngaged)
                this._leaveFitAll({animate: false});
        });
    }

    // FIXME downstream: Upstream _getFirstFitAllWorkspaceBox divides available
    // width by nWorkspaces, so each workspace tries to fill the full monitor
    // width and spacing*(n+1) eats proportional space as n grows. We replace
    // it with a porthole-proportional scale (like ThumbnailsBox) with a
    // MIN_WS_SCALE floor, so workspaces shrink gracefully and spacing stays
    // bounded. Ideal upstream fix: add a min-scale property to
    // WorkspacesView or share the ThumbnailsBox scaling model.
    //
    // Both _getSpacing AND _getFirstFitAllWorkspaceBox are patched: the former
    // controls the per-step advance in vfunc_allocate's loop, the latter
    // controls the initial box origin + size. They must agree on spacing.
    _patchFitAllLayout() {
        if (this._fitAllPatched)
            return;
        const proto = WorkspacesView.prototype;
        this._origGetFirstFitAllWorkspaceBox = proto._getFirstFitAllWorkspaceBox;
        this._origGetSpacing = proto._getSpacing;
        const origGetSpacing = this._origGetSpacing;
        const self = this;

        // Shared helper: computes scale + adjusted spacing for FitMode.ALL.
        // Returns {scale, wsSize, adjSpacing, margin} where wsSize is the
        // workspace width (horizontal) or height (vertical), and margin is
        // the offset that centers the row.
        const _computeFitAll = (avail, n, portholeSize, spacing) => {
            // idealScale: the largest scale whose workspaces plus their own
            // proportional gaps still fit, from
            // avail = n * wsSize + (n + 1) * WORKSPACE_GAP_RATIO * wsSize.
            // Upstream instead subtracts a flat spacing (24px at the ALL-mode
            // clamp), which stays put while the workspaces shrink.
            const idealScale =
                avail / (portholeSize * (n + WORKSPACE_GAP_RATIO * (n + 1)));

            // With proportional scaling, we want workspaces to shrink
            // gracefully: transition from idealScale toward MIN_WS_SCALE as n
            // grows, but never exceed idealScale (so few-workspaces layout is
            // preserved) and never go below MIN_WS_SCALE unless the row cannot
            // hold them at that size.
            let scale = Math.min(idealScale, 1.0);

            // Spring toward MIN_WS_SCALE: blend idealScale with MIN_WS_SCALE
            // proportional to how many workspaces beyond a threshold.
            // This makes spacing shrink BEFORE hitting zero.
            const SPRING_THRESHOLD = 4;
            if (n > SPRING_THRESHOLD) {
                const t = Math.min((n - SPRING_THRESHOLD) / SPRING_THRESHOLD, 1.0);
                const sprung = idealScale * (1 - t) + MIN_WS_SCALE * t;
                scale = Math.min(scale, sprung);
            }
            scale = Math.max(scale, MIN_WS_SCALE);

            // Hard floor: past ~6 workspaces MIN_WS_SCALE asks for more room
            // than the row has, and idealScale is by construction the largest
            // scale that still fits with its gaps. Filling the row edge to
            // edge instead would trade the whole gap budget for under 1% of
            // size, and read as one wide workspace rather than several.
            scale = Math.min(scale, idealScale);

            const wsSize = Math.round(portholeSize * scale);

            // Spacing absorbs leftover space, but only up to its share of the
            // workspace it separates. Without the cap every pixel the scale
            // caps (at 1.0), springs or floors away comes back as gap, so the
            // emptier the row the wider its holes.
            let adjSpacing;
            if (n > 1) {
                const leftover = avail - wsSize * n;
                adjSpacing = Math.min(Math.max(leftover / (n + 1), 0),
                    WORKSPACE_GAP_RATIO * wsSize);
            } else {
                adjSpacing = spacing;
            }

            // What the gaps did not absorb goes to the ends. vfunc_allocate
            // steps by wsSize + adjSpacing (workspacesView.js:376-386), so
            // this is the row's real extent.
            const margin = Math.max(
                (avail - (wsSize * n + adjSpacing * (n - 1))) / 2, 0);

            return {scale, wsSize, adjSpacing, margin};
        };

        proto._getSpacing = function (box, fitMode, vertical) {
            if (fitMode !== FitMode.ALL || !self._spatialLayoutActive())
                return origGetSpacing.call(this, box, fitMode, vertical);

            const [width, height] = box.get_size();
            const {nWorkspaces} = global.workspaceManager;

            const workarea = Main.layoutManager.getWorkAreaForMonitor(
                this._monitorIndex);
            const portholeW = workarea?.width ?? width;
            const portholeH = workarea?.height ?? height;

            // Start from upstream's spacing value for ALL mode.
            const upstream = origGetSpacing.call(this, box, fitMode, vertical);

            const avail = vertical ? height : width;
            const portholeSize = vertical ? portholeH : portholeW;
            const {adjSpacing} = _computeFitAll(avail, nWorkspaces,
                portholeSize, upstream);
            return adjSpacing;
        };

        proto._getFirstFitAllWorkspaceBox = function (box, spacing, vertical) {
            if (!self._spatialLayoutActive())
                return self._origGetFirstFitAllWorkspaceBox.call(this, box, spacing, vertical);

            const {nWorkspaces} = global.workspaceManager;
            const [width, height] = box.get_size();
            const [workspace] = this._workspaces;

            const fitAllBox = new Clutter.ActorBox();
            let [x1, y1] = box.get_origin();

            const workarea = Main.layoutManager.getWorkAreaForMonitor(
                this._monitorIndex);
            const portholeW = workarea?.width ?? width;
            const portholeH = workarea?.height ?? height;

            let gap = 0;
            if (vertical) {
                const {wsSize: wsH, adjSpacing, margin} = _computeFitAll(
                    height, nWorkspaces, portholeH, spacing);
                gap = adjSpacing;
                y1 = margin;
                const [, wsW] = workspace.get_preferred_width(wsH);
                if (wsW > width) {
                    const [, realH] = workspace.get_preferred_height(width);
                    y1 = Math.max(
                        (height - (realH * nWorkspaces +
                            adjSpacing * (nWorkspaces - 1))) / 2, 0);
                }
                fitAllBox.set_size(width, wsH);
            } else {
                const {wsSize: wsW, adjSpacing, margin} = _computeFitAll(
                    width, nWorkspaces, portholeW, spacing);
                gap = adjSpacing;
                x1 = margin;
                const [, wsH] = workspace.get_preferred_height(wsW);
                if (wsH > height) {
                    const [, realW] = workspace.get_preferred_width(height);
                    x1 = Math.max(
                        (width - (realW * nWorkspaces +
                            adjSpacing * (nWorkspaces - 1))) / 2, 0);
                }
                fitAllBox.set_size(wsW, height);
            }

            fitAllBox.set_origin(x1, y1);

            logTime('fitAllLayout', JSON.stringify({
                n: nWorkspaces,
                scale: (fitAllBox.get_size()[0] / portholeW).toFixed(3),
                wsW: fitAllBox.get_size()[0], gap: Math.round(gap),
                x1: Math.round(x1), portholeW,
            }));

            return fitAllBox;
        };

        // FIXME downstream: LayoutStrategy gets the theme's spacing plus the
        // window chrome oversize in screen pixels (workspace.js:478-495) and
        // computeWindowSlots lays them out inside whatever box it is handed
        // (workspace.js:329,382). workspace.js:70 already admits the spacing
        // "is not scaled, it's constant", so a workspace re-solved at a third
        // of its size still holds the full ~30px between previews. Ideal
        // upstream fix: scale spacing and oversize by the allocation scale
        // the layout is being asked to fill.
        //
        // This covers the re-solved path only. While the per-instance pin
        // installed by _engageSpatialLayout holds, fit-all is the
        // FitMode.SINGLE answer scaled by slotsScale, so its gaps already
        // shrink with the workspace; the pin drops itself when a window comes
        // or goes and hands the box back to upstream, which is where the
        // constant spacing shows up.
        //
        // Only the slot pass is scaled. _createBestLayout picks the rows and
        // columns against the whole workarea and caches them until a window
        // comes or goes, so scaling there would let fit-all settle on a
        // different grid than the overview's and reshuffle the previews on
        // every zoom.
        this._origGetWindowSlots = WorkspaceLayout.prototype._getWindowSlots;
        const origGetWindowSlots = this._origGetWindowSlots;
        WorkspaceLayout.prototype._getWindowSlots = function (containerBox) {
            if (!self._spatialEngaged || !this._layoutStrategy || !this._workarea)
                return origGetWindowSlots.call(this, containerBox);

            const strategy = this._layoutStrategy;
            const scale = Math.min(
                containerBox.get_width() / this._workarea.width, 1);
            const rowSpacing = strategy._rowSpacing;
            const colSpacing = strategy._columnSpacing;
            strategy._rowSpacing = rowSpacing * scale;
            strategy._columnSpacing = colSpacing * scale;
            try {
                return origGetWindowSlots.call(this, containerBox);
            } finally {
                strategy._rowSpacing = rowSpacing;
                strategy._columnSpacing = colSpacing;
            }
        };

        this._fitAllPatched = true;
    }

    _restoreFitAllLayout() {
        if (!this._fitAllPatched)
            return;
        const proto = WorkspacesView.prototype;
        if (this._origGetFirstFitAllWorkspaceBox)
            proto._getFirstFitAllWorkspaceBox = this._origGetFirstFitAllWorkspaceBox;
        if (this._origGetSpacing)
            proto._getSpacing = this._origGetSpacing;
        if (this._origGetWindowSlots)
            WorkspaceLayout.prototype._getWindowSlots = this._origGetWindowSlots;
        this._origGetFirstFitAllWorkspaceBox = null;
        this._origGetSpacing = null;
        this._origGetWindowSlots = null;
        this._fitAllPatched = false;
    }

    disable() {
        this._restoreMinWorkspaces();

        if (this._dragActive)
            this._onDragEnd();

        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._draggedMetaWindow = null;

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
        if (this._overviewHidingId) {
            Main.overview.disconnect(this._overviewHidingId);
            this._overviewHidingId = null;
        }

        this._disarmFitAllEscape();
        // The adjustment is the shell's own. Disabling while held in fit-all
        // would leave it there with nothing left to ease it back.
        const fitAdj = this._getWsDisplay()?._fitModeAdjustment;
        if (this._spatialEngaged && fitAdj) {
            fitAdj.remove_transition('value');
            fitAdj.value = FitMode.SINGLE;
        }

        this._disconnectFitModeNotify();
        this._removeRestoreIdle();
        this._removeEngageTimeout();
        this._cancelAllocationWait();
        this._spatialEngaged = false;
        this._restoreWorkspacesState();
        this._restorePreviewActivate();
        this._restoreFitAllLayout();
        this._restorePanelLayout();
        this._restoreWorkspaceDots();
        this._restoreHotCorner();
        this._dragActive = false;

        if (this._zoomOutView) {
            this._zoomOutView.destroy();
            this._zoomOutView = null;
        }
    }

    _onDragBegin(metaWindow) {
        logTime('_onDragBegin ENTER (zoom-out held back)');
        this._dragActive = true;
        // A drag started from a held fit-all: Esc is dnd's for its duration, it
        // cancels the drag (dnd.js:568-570). Which of the two handlers the key
        // reaches first is not ours to assume - dnd's grab redirects events to
        // its own actor and skips the capture phase we listen on (dnd.js:44-45)
        // - so disarm instead of racing. _onDragEnd arms it again.
        this._disarmFitAllEscape();
        const self = this;
        this._draggedMetaWindow = metaWindow;

        this._lastCursorX = 0;
        this._lastCursorY = 0;
        this._dragMotionCount = 0;
        this._activeDraggable = null;
        this._dropInsertIndex = -1;
        this._dropWorkspaceIndex = -1;

        this._dragMonitor = {
            dragMotion: (dragEvent) => {
                this._draggedMetaWindow = dragEvent.source?.metaWindow || this._draggedMetaWindow;
                if (!this._activeDraggable && dragEvent.source?._draggable) {
                    this._activeDraggable = dragEvent.source._draggable;
                    const draggable = this._activeDraggable;

                    // FIXME downstream: _getRestoreLocation returns
                    // parentX + parentScale * _dragOrigX (dnd.js:465-470), but
                    // _dragOrigX is the clone's allocation inside that parent as
                    // it stood at gesture recognition (dnd.js:202) - a
                    // FitMode.SINGLE container coordinate - and parentScale is
                    // the actor's scale transform, which does not move when the
                    // container's allocation does. So nothing in that sum
                    // converts the 962px-wide container the drag began in into
                    // the 423px-wide one it ends in; WorkspaceLayout does the
                    // miniaturising through slotsScale (workspace.js:683), where
                    // dnd cannot see it. The snap-back therefore aims at the
                    // fit-single slot and _onAnimationComplete reparents the
                    // clone onto the fit-all one (dnd.js:519-524). Their
                    // difference is the jump. A drag begun with fit-all already
                    // held has none: there the two readings agree.
                    //
                    // Ideal upstream fix: record the restore location as a
                    // fraction of the parent rather than in pixels.
                    const origParentWidth =
                        draggable._dragOrigParent?.get_width() ?? 0;
                    this._origGetRestoreLocation = draggable._getRestoreLocation;
                    draggable._getRestoreLocation = function () {
                        const [x, y, scale] =
                            self._origGetRestoreLocation.call(this);
                        const parent = this._dragOrigParent;
                        if (this._dragActorSource || !parent?.get_stage() ||
                            !(origParentWidth > 0))
                            return [x, y, scale];

                        const s = parent.get_width() / origParentWidth;
                        if (s === 1)
                            return [x, y, scale];

                        // x is parentX + parentScale * _dragOrigX
                        // (dnd.js:468), so rescaling about the parent's origin
                        // needs no second reading of parentScale.
                        const [parentX, parentY] =
                            parent.get_transformed_position();
                        logTime('restore location rescaled', {s});
                        return [
                            parentX + (x - parentX) * s,
                            parentY + (y - parentY) * s,
                            scale * s,
                        ];
                    };

                    // FIXME downstream: the ratio above is only as good as the
                    // moment it is read, and _animateDragEnd eases to a single
                    // reading taken at the drop (dnd.js:494-505). Upstream can
                    // afford that: nothing relayouts a workspace mid-drag. The
                    // zoom-out does, for 210ms, so a drop taken while it is in
                    // flight measures a container that is still shrinking -
                    // 868px one frame in, against the 423px it settles at, so
                    // the snap-back is aimed at roughly twice its final size.
                    //
                    // Wait the row out instead: the snap-back is 250ms and
                    // starts at the drop, the zoom is 210ms and started before
                    // it, so the row always settles first and there is always a
                    // frame where the reading is final. The clone holds where it
                    // was dropped until then.
                    //
                    // Ideal upstream fix: let a drag origin whose geometry is
                    // animating defer the snap-back until it settles, the way a
                    // drop target could invalidate a stale hover.
                    this._origAnimateDragEnd = draggable._animateDragEnd;
                    const origAnimateDragEnd = this._origAnimateDragEnd;
                    draggable._animateDragEnd = function (eventTime, params) {
                        const transition = self._getWsDisplay()
                            ?._fitModeAdjustment?.get_transition('value');
                        if (!transition) {
                            origAnimateDragEnd.call(this, eventTime, params);
                            return;
                        }

                        logTime('snap-back deferred until the zoom settles');
                        // What _animateDragEnd would have set. The drag is
                        // already on its way back, and a clone destroyed before
                        // the tween starts still has to reach _finishAnimation
                        // (dnd.js:236-237) for the draggable to be torn down.
                        this._animationInProgress = true;
                        // Not on 'stopped' alone: the value that ends the
                        // transition only queues the relayout that resolves the
                        // row (workspacesView.js:99-103), and 'stopped' lands in
                        // the same frame. get_width() on an actor still owing an
                        // allocation answers with its preferred width, which for
                        // WorkspaceLayout is the whole workarea (workspace.js:
                        // 607-609) - a constant, and the ratio built from it
                        // read 1.29 no matter when the drop came.
                        transition.connect('stopped', () => {
                            self._afterAllocation(this._dragOrigParent, () => {
                                if (!this._dragActor)
                                    return;
                                this._animationInProgress = false;

                                const [x, y, scale] = this._getRestoreLocation();
                                // _cancelDrag eases to the location it read
                                // (dnd.js:603-611); _restoreDragActor puts the
                                // clone there first and eases opacity alone
                                // (dnd.js:481-491). Both readings are the stale
                                // one, so replace whichever this call carries.
                                if ('x' in params) {
                                    origAnimateDragEnd.call(this, eventTime, {
                                        ...params,
                                        x, y, scale_x: scale, scale_y: scale,
                                    });
                                } else {
                                    this._dragActor.set_position(x, y);
                                    this._dragActor.set_scale(scale, scale);
                                    origAnimateDragEnd.call(
                                        this, eventTime, params);
                                }
                            });
                        });
                    };

                    const restoreId = draggable.connect('drag-end', () => {
                        self._reattachDetachedSlots();
                        draggable._getRestoreLocation =
                            self._origGetRestoreLocation;
                        self._origGetRestoreLocation = null;
                        draggable._animateDragEnd = self._origAnimateDragEnd;
                        self._origAnimateDragEnd = null;
                        draggable.disconnect(restoreId);
                    });
                }
                this._lastCursorX = dragEvent.x;
                this._lastCursorY = dragEvent.y;
                this._dragMotionCount++;
                if (this._dragMotionCount % 10 === 1)
                    logTime('dragMotion', {
                        n: this._dragMotionCount,
                        x: dragEvent.x, y: dragEvent.y,
                    });
                return DND.DragMotionResult.CONTINUE;
            },
            // No dragDrop: skip monitor's drop callback entirely, let
            // dnd.js's _dragActorDropped walk its target chain. Our ZoomOutView
            // has acceptDrop which will handle the workspace change.
            dragDrop: undefined,
        };
        DND.addDragMonitor(this._dragMonitor);

        // Deferring the monitor along with it would lose the capture: the
        // draggable and its restore location are read on the first motion
        // event. Until _engageSpatialLayout runs the ZoomOutView stays hidden,
        // so a drag released within the delay never reaches our acceptDrop and
        // the drop falls through to upstream.
        this._removeEngageTimeout();
        this._engageTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, ZOOM_OUT_HOLD_DELAY, () => {
                this._engageTimeoutId = 0;
                this._engageSpatialLayout();
                return GLib.SOURCE_REMOVE;
            });
    }

    _engageSpatialLayout() {
        logTime('_engageSpatialLayout ENTER (zoom-out will start)');
        const self = this;

        const controls = this._getControls();
        if (controls) {
            const ws = controls._workspacesDisplay;
            // The one place the app grid decides anything: whether we engage
            // at all. Everything downstream of here asks _spatialLayoutActive.
            if (ws?._fitModeAdjustment && !self._isInAppGrid()) {
                this._spatialEngaged = true;
                ws._fitModeAdjustment.remove_transition('value');

                // FIXME downstream: _updateDragPosition (dnd.js:373-382) is the
                // only thing that ever queues a re-pick, so dnd re-reads the
                // drop target when the pointer moves and at no other time. A
                // workspace that slides under a still cursor is therefore never
                // offered: the cursor keeps its NO_DROP, and _dropWorkspaceIndex
                // still holds the -1 from the last handleDragOver pass, so
                // acceptDrop refuses and dnd cancels the drag. Upstream never
                // sees it because nothing moves a drop target mid-drag; the zoom
                // moves every one of them, so re-pick on each of its frames.
                //
                // Re-testing acceptDrop's own x/y instead would break the
                // invariant handleDragOver documents - hover decides, acceptDrop
                // consumes - and it is the hover that is stale here anyway.
                //
                // Ideal upstream fix: let a drop target invalidate the hover
                // when its geometry changes under the pointer.
                this._fitModeNotifyAdj = ws._fitModeAdjustment;
                this._fitModeNotifyId = this._fitModeNotifyAdj.connect(
                    'notify::value', () => this._revalidateDragHover());

                ws._fitModeAdjustment.ease(FitMode.ALL, {
                    duration: ZOOM_OUT_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }

            // FIXME downstream: whenever upstream GNOME exposes this flag,
            // drop this monkey-patch. (Tracked for upstream contribution.)
            //
            // _updateWorkspacesState computes workspaceMode = (1 - fitMode) * lerp(...)
            // which is 0 in FitMode.ALL - causing WindowPreviews to render in
            // desktop mode (overflowing the shrunken Workspace actor). We
            // force stateAdjustment.value = 1 so WindowPreviews rearrange
            // (overview layout) to fit the Workspace rect in FitMode.ALL.
            //
            // The scale two lines below it (workspacesView.js:263) needs the
            // same treatment and does not get it: every workspace further than
            // one step from the scroll position is drawn at
            // WORKSPACE_INACTIVE_SCALE, shrunk about its own centre. That is
            // emphasis for FitMode.SINGLE, where only the neighbours peek in
            // at the edges. In FitMode.ALL the whole row is on screen, so the
            // 6% each panel gives up becomes gap - 3% on its left, 3% on its
            // right, and 6% of a panel between two inactive neighbours, which
            // dwarfs the spacing the layout actually asks for.
            //
            // Keep the emphasis, drop the hole: put the row at 1 and grow the
            // current workspace instead, reusing upstream's own scaleProgress
            // so the accent still hands over smoothly as the scroll position
            // moves. What it grows into is the gap, not reserved space, so it
            // has to be drawn above its neighbours.
            //
            // Ideal upstream fix: make the emphasis grow the current workspace
            // rather than shrink the rest, so a row that shows every workspace
            // at once does not have to reserve the difference beside each one.
            for (const view of ws._workspacesViews ?? []) {
                if (!view._workspaces || view._origUpdateWorkspacesState)
                    continue;
                view._origUpdateWorkspacesState = view._updateWorkspacesState;
                const origFn = view._origUpdateWorkspacesState;
                view._updateWorkspacesState = function () {
                    origFn?.call(this);
                    if (!self._spatialLayoutActive())
                        return;

                    const adj = this._scrollAdjustment;
                    // The accent belongs to the row, so it has to arrive and
                    // leave with it. Weighting by fitMode is upstream's own
                    // idiom for the same reason one line up
                    // (workspacesView.js:250).
                    const fitMode = this._fitModeAdjustment.value;
                    let top = null;
                    let topProgress = 0;
                    (this._workspaces ?? []).forEach((w, index) => {
                        w.stateAdjustment.value = 1;

                        const progress =
                            1 - Math.clamp(Math.abs(adj.value - index), 0, 1);
                        const accent =
                            1 + (WORKSPACE_ACTIVE_SCALE - 1) * progress;
                        // origFn left upstream's own answer on the actor, so
                        // blending out of it is what makes FitMode.SINGLE agree
                        // with upstream to the pixel - and handing the state
                        // back at the end of a zoom-in changes nothing on screen.
                        const scale = w.scale_x + (accent - w.scale_x) * fitMode;
                        w.set_scale(scale, scale);

                        if (progress > topProgress) {
                            topProgress = progress;
                            top = w;
                        }
                    });
                    // This runs on every frame of the zoom; restacking an
                    // actor that is already on top still rebuilds the child
                    // list and queues a redraw.
                    if (top && this.get_last_child() !== top)
                        this.set_child_above_sibling(top, null);
                };
                view._updateWorkspacesState();
            }

            // FIXME downstream: WorkspaceLayout re-runs the layout for whatever
            // box it is given (workspace.js:677-680), so in FitMode.ALL it
            // solves the window arrangement inside the shrunken Workspace actor
            // instead of showing the FitMode.SINGLE arrangement smaller. The
            // two are not the same picture: computeWindowSlots only ever clamps
            // (its additionalScale is Math.min(1, ...), workspace.js:317/331),
            // and the layout it clamps was already solved against the workarea
            // by _createBestLayout (workspace.js:672), so shrinking the box
            // re-packs the row rather than scaling it.
            //
            // Freeze the FitMode.SINGLE answer instead: pin the box and the
            // slots upstream computed for it, then hand the same slots back for
            // the rest of the drag. slotsScale (=containerW/refW,
            // workspace.js:683) does the miniaturising, so FitMode.ALL is the
            // fit-single workspace scaled down and nothing re-flows at either
            // end of the zoom.
            //
            // Ideal upstream fix: let a WorkspacesView in FitMode.ALL ask for a
            // scaled workspace rather than a re-solved one.
            for (const view of ws._workspacesViews ?? []) {
                for (const w of view._workspaces ?? []) {
                    const container = w._container;
                    const lm = container?.layout_manager;
                    if (lm && lm._origGetWindowSlots === undefined) {
                        // Upstream already caches this pair for the geometry it
                        // last allocated, which is the FitMode.SINGLE one:
                        // _windowSlotsBox is the box it solved for and
                        // _windowSlots the answer (workspace.js:677-680). Pin
                        // them rather than recomputing - no second opinion to
                        // disagree with.
                        if (!lm._windowSlotsBox || !lm._windowSlots ||
                            !(lm._windowSlotsBox.get_width() > 0))
                            continue;
                        lm._origGetWindowSlots = lm._getWindowSlots;
                        lm._spatialRefBox = lm._windowSlotsBox.copy();
                        lm._spatialRefLayout = lm._layout;
                        lm._spatialRefSlots = lm._windowSlots;
                        lm._spatialDetached = [];

                        lm._getWindowSlots = function (containerBox) {
                            if (!self._spatialLayoutActive() ||
                                !this._spatialRefSlots)
                                return this._origGetWindowSlots.call(this, containerBox);
                            // The pin describes one layout. A drop that adds or
                            // removes a window rebuilds it (workspace.js:672),
                            // and re-pinning here would bake in
                            // _adjustSpacingAndPadding's reading of a container
                            // transform that is mid-zoom (workspace.js:500-509):
                            // the wrong y2 clamp, hence a workspace still
                            // mis-centred after the zoom, with nothing left to
                            // recompute it. Drop the pin and let upstream solve
                            // for the live box for the rest of the drag.
                            if (this._layout !== this._spatialRefLayout) {
                                this._spatialRefSlots = null;
                                return this._origGetWindowSlots.call(this, containerBox);
                            }
                            this._windowSlotsBox = this._spatialRefBox;
                            return this._spatialRefSlots;
                        };
                    }

                    // Every engage, not only the one that installs the pin: a
                    // drag begun from a held fit-all finds the pin already
                    // there, and its clone would keep its slot.
                    if (lm?._spatialRefSlots)
                        this._detachDraggedSlots(lm, container);
                }
            }
        }

        if (this._zoomOutView)
            this._zoomOutView.show();
    }

    _handleDrop(source, x, y) {
        const metaWindow = source?.metaWindow ?? this._draggedMetaWindow;
        logTime('_handleDrop', {
            hasSource: !!source,
            hasMetaWindow: !!metaWindow,
            x, y,
            fromDraggedMW: source?.metaWindow == null,
            sourceKeys: source ? Object.keys(source).filter(k => k !== '_delegate') : [],
        });
        if (!metaWindow) {
            logTime('_handleDrop: NO metaWindow -> skip');
            this._dropWasNoop = true;
            this._clearDragPlaceholder();
            return false;
        }

        // FIXME downstream: create-new-workspace-via-drop replica of
        // ThumbnailsBox.acceptDrop (workspaceThumbnail.js:877-920).
        // Upstream WorkspacesView has no drop-to-create path.
        //
        // Consumes what handleDragOver decided, like upstream acceptDrop; x/y
        // are logged but never re-tested. See the note there.
        const {_dropInsertIndex: insertIndex, _dropWorkspaceIndex: wsIndex} = this;
        this._clearDragPlaceholder();

        if (insertIndex >= 0) {
            logTime('_handleDrop: insert workspace at', insertIndex);
            this._createWorkspaceAt(insertIndex, metaWindow);
            return true;
        }

        if (wsIndex < 0) {
            logTime('_handleDrop: outside any workspace -> skip (no anim)');
            this._dropWasNoop = true;
            return false;
        }
        const targetWs = global.workspace_manager.get_workspace_by_index(wsIndex);
        const currentWs = metaWindow.get_workspace();
        if (currentWs === targetWs) {
            logTime('_handleDrop: same workspace -> skip (no anim)');
            this._dropWasNoop = true;
            return false;
        }
        logTime('_handleDrop: change_workspace CALLED', {
            from: currentWs?.index?.() ?? -1,
            to: wsIndex,
            title: metaWindow.get_title?.() ?? '?',
        });
        metaWindow.change_workspace(targetWs);
        // Don't snap fitModeAdjustment here - _onDragEnd (triggered
        // synchronously by change_workspace -> window-drag-end signal)
        // owns the zoom-in ease. Snapping here would remove_transition
        // and set value=FitMode.SINGLE mid-ease, skipping the animation.
        logTime('_handleDrop: change_workspace RETURNED');
        return true;
    }

    // FIXME downstream: replica of ThumbnailsBox.acceptDrop (workspaceThumbnail.js:890-920).
    // Creates a new workspace at `index` and moves the window there.
    _createWorkspaceAt(index, metaWindow) {
        if (!Meta.prefs_get_dynamic_workspaces()) {
            logTime('_createWorkspaceAt: dynamic workspaces disabled');
            return;
        }
        logTime('_createWorkspaceAt CALLED', {
            index,
            title: metaWindow?.get_title?.() ?? '?',
        });

        // Main.wm.insertWorkspace handles: append_new_workspace + slide
        // windows rightward to leave position `index` empty.
        // (windowManager.js:1019-1050)
        Main.wm.insertWorkspace(index);

        const monIdx = Main.layoutManager.primaryIndex;
        Main.moveWindowToMonitorAndWorkspace(
            metaWindow, monIdx, index, true);

        // Keep the workspace alive briefly so startup apps don't
        // immediately destroy it (workspaceThumbnail.js:918-920).
        Main.wm.keepWorkspaceAlive(
            global.workspace_manager.get_workspace_by_index(index), 100);

        logTime('_createWorkspaceAt DONE', {index});
    }

    // Mirrors ThumbnailsBox._clearDragPlaceholder
    // (workspaceThumbnail.js:764-770), early return included.
    _clearDragPlaceholder() {
        if (this._dropInsertIndex === -1)
            return;

        this._dropInsertIndex = -1;
        this._zoomOutView?.setDropPlaceholderRect(null);
    }

    // _queueUpdateDragHover coalesces onto a single idle (dnd.js:364-372), so
    // one call per frame of the zoom costs one pick.
    //
    // Both guards are load-bearing. _dragActive is already false while the
    // snap-back runs - dnd emits drag-end from _onAnimationComplete and only
    // reaches _dragComplete afterwards (dnd.js:518-529) - so it is what keeps
    // the zoom-in from re-picking for a drag that is over. _dragActor is what
    // _pickTargetActor dereferences (dnd.js:302) and _dragComplete nulls it
    // (dnd.js:553), so queueing past that point throws on the idle.
    _revalidateDragHover() {
        if (!this._dragActive)
            return;
        const draggable = this._activeDraggable;
        if (draggable?._dragActor)
            draggable._queueUpdateDragHover();
    }

    _disconnectFitModeNotify() {
        if (!this._fitModeNotifyId)
            return;
        this._fitModeNotifyAdj?.disconnect(this._fitModeNotifyId);
        this._fitModeNotifyId = 0;
        this._fitModeNotifyAdj = null;
    }

    _onDragEnd(isCancel = false) {
        if (!this._dragActive) {
            logTime('_onDragEnd: not active (already ended?) -> skip');
            return;
        }
        this._dragActive = false;
        // Connected per engage, so it has to go per drag: the adjustment is the
        // shell's own and outlives us, and the next engage would connect a
        // second handler onto it rather than replace this one.
        this._disconnectFitModeNotify();

        const heldBack = this._engageTimeoutId !== 0;
        this._removeEngageTimeout();

        logTime('_onDragEnd START', {
            dragMotionTotal: this._dragMotionCount,
            isCancel,
            heldBack,
            dropWasNoop: !!this._dropWasNoop,
        });
        this._dropWasNoop = false;

        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._draggedMetaWindow = null;

        // Same point upstream clears it: _endDrag (workspaceThumbnail.js:748),
        // reached from _onDragEnd and _onDragCancelled.
        this._clearDragPlaceholder();

        const ws = this._getWsDisplay();

        // Releasing the window is not what leaves fit-all - Esc is. A drag that
        // never got as far as zooming out has nothing to hold, so it still
        // unwinds here.
        //
        // Cancelled drags hold too. Esc during a drag already means "cancel the
        // drag" (dnd.js:568-570), so a cancel that also left fit-all would make
        // one key do two things. The second Esc is the one that leaves.
        if (this._spatialLayoutActive()) {
            logTime('_onDragEnd: holding fit-all', {isCancel});
            this._armFitAllEscape();
        } else {
            logTime('_onDragEnd: not engaged, nothing to hold', {isCancel});
            this._spatialEngaged = false;
            this._restoreWorkspacesState();
        }

        if (ws) {
            for (const view of ws._workspacesViews ?? []) {
                for (const w of view._workspaces ?? [])
                    w.reactive = true;
            }
        }

        if (this._zoomOutView?.visible)
            this._zoomOutView.hide();
    }

    // FIXME downstream: in FitMode.ALL the first click on a preview two
    // workspaces over is spent selecting that workspace. _onCloneSelected only
    // activates the window when _shouldLeaveOverview() agrees, and for an
    // inactive workspace at WINDOW_PICKER it does not (workspace.js:1111-1117,
    // 1393-1399), so the window needs a second click. That reading fits
    // FitMode.SINGLE, where the neighbours only peek in from the edges; with
    // every workspace fully on screen the click already has a target.
    // Ideal upstream fix: let _shouldLeaveOverview account for the fit mode.
    //
    // The hook is _activate and not _onCloneSelected: the latter is bound per
    // clone at connect time (workspace.js:1339-1340), so replacing it on a
    // Workspace changes nothing. The click gesture reaches _activate through an
    // arrow (windowPreview.js:118-119), and the prototype also covers previews
    // built after the hold started - a cross-workspace drop rebuilds one.
    _patchPreviewActivate() {
        if (this._origPreviewActivate)
            return;

        const self = this;
        const orig = WindowPreview.prototype._activate;
        this._origPreviewActivate = orig;

        WindowPreview.prototype._activate = function () {
            if (!self._spatialLayoutActive()) {
                orig.call(this);
                return;
            }

            const metaWindow = this.metaWindow;
            const time = global.get_current_time();
            const wsIndex = metaWindow.get_workspace()?.index() ?? -1;
            logTime('click on preview: zoom in, then activate', {wsIndex});
            // The window comes after the zoom-in rather than with it:
            // Main.activateWindow hides the overview (main.js:859), and the
            // leave animation starts from whatever picture it finds.
            self._leaveFitAll({
                duration: ZOOM_IN_ACTIVATE_DURATION,
                scrollTo: wsIndex,
                onDone: () => Main.activateWindow(metaWindow, time),
            });
        };
    }

    _restorePreviewActivate() {
        if (!this._origPreviewActivate)
            return;

        WindowPreview.prototype._activate = this._origPreviewActivate;
        this._origPreviewActivate = null;
    }

    // Esc is the way out of fit-all. Capture phase, which is upstream's own
    // idiom for the same key (grabHelper.js:168-176): the search controller
    // takes Esc on the stage's key-press-event and turns it into
    // Main.overview.hide() (searchController.js:152-158), and that handler is
    // reconnected on every overview show, so it would always be the newer of
    // the two in the bubble phase.
    _armFitAllEscape() {
        if (this._escapeCapturedId)
            return;

        this._escapeCapturedId = global.stage.connect('captured-event',
            (_actor, event) => {
                if (event.type() !== Clutter.EventType.KEY_PRESS ||
                    event.get_key_symbol() !== Clutter.KEY_Escape)
                    return Clutter.EVENT_PROPAGATE;

                logTime('Esc: leaving fit-all');
                this._leaveFitAll();
                return Clutter.EVENT_STOP;
            });
    }

    _disarmFitAllEscape() {
        if (!this._escapeCapturedId)
            return;

        global.stage.disconnect(this._escapeCapturedId);
        this._escapeCapturedId = 0;
    }

    _leaveFitAll({animate = true, onDone = null, scrollTo = -1,
        duration = ZOOM_IN_DURATION} = {}) {
        this._disarmFitAllEscape();

        // The overview is already going. prepareToLeaveOverview freezes each
        // WorkspaceLayout (workspace.js:1299) before 'hiding' is emitted
        // (overview.js:574-575), so the slots are fixed by the time we get here
        // and the pin makes them the FitMode.SINGLE ones. Only the workspace
        // transform is left, and easing it would run alongside the leave
        // animation rather than before it.
        if (!animate) {
            logTime('_leaveFitAll: snapping to FitMode.SINGLE');
            this._spatialEngaged = false;
            const adj = this._getWsDisplay()?._fitModeAdjustment;
            if (adj) {
                adj.remove_transition('value');
                adj.value = FitMode.SINGLE;
            }
            // remove_transition above stops any zoom-in ease, and its onStopped
            // queues a restore. Drop it: this one runs now.
            this._removeRestoreIdle();
            this._restoreWorkspacesState();
            onDone?.();
            return;
        }

        // Not value alone: a drop landing within a frame of _engageSpatialLayout
        // finds the ease to FitMode.ALL queued but not yet advanced, so the
        // value still reads exactly SINGLE while a zoom-out is in flight.
        // Taking the no-op branch there left that ease running with nothing to
        // undo it, stranding the overview in fit-all.
        const fitAdj = this._getWsDisplay()?._fitModeAdjustment;
        const alreadyChanged = fitAdj?.value === FitMode.SINGLE &&
            !fitAdj?.get_transition('value');
        if (alreadyChanged || !fitAdj || !this._spatialLayoutActive()) {
            logTime('_leaveFitAll: no zoom-in', {engaged: this._spatialEngaged});
            this._spatialEngaged = false;
            this._restoreWorkspacesState();
            onDone?.();
            return;
        }

        logTime('_leaveFitAll: starting zoom-in ease to FitMode.SINGLE',
            {duration, scrollTo});
        // The zoom-in resolves onto whichever workspace the scroll position
        // names, so a click two workspaces over has to carry it along.
        // activate_with_focus gets there on its own, but only afterwards -
        // _scrollToActive runs off the switch-workspace signal
        // (workspacesView.js:406-419), which is the slide across that shows up
        // between the zoom-in and the desktop.
        const scrollAdj = this._getWsDisplay()?._scrollAdjustment;
        if (scrollTo >= 0 && scrollAdj && scrollAdj.value !== scrollTo) {
            scrollAdj.remove_transition('value');
            scrollAdj.ease(scrollTo, {
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }

        fitAdj.remove_transition('value');
        fitAdj.ease(FitMode.SINGLE, {
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                // Not earlier: the ease allocates on every frame, and each
                // allocation asks _spatialLayoutActive.
                this._spatialEngaged = false;
                this._removeRestoreIdle();
                this._restoreIdleId = GLib.idle_add(
                    GLib.PRIORITY_DEFAULT, () => {
                        this._restoreIdleId = 0;
                        this._restoreWorkspacesState();
                        return GLib.SOURCE_REMOVE;
                    });
                onDone?.();
            },
        });
    }

    // FIXME downstream: a preview being dragged keeps its slot - removeWindow
    // (workspace.js:853) says as much, "the window might have been reparented
    // by DND" - so vfunc_allocate keeps calling child.allocate() on an actor
    // that now lives in Main.uiGroup. The slot box is container-local, so it
    // lands somewhere else entirely, and the clone only snaps back under the
    // pointer on the next motion event, when dnd re-asserts its fixed position.
    // Upstream never sees this because nothing relayouts a workspace mid-drag;
    // the zoom does it every frame.
    // Ideal upstream fix: skip slots whose actor the container no longer parents.
    _detachDraggedSlots(lm, container) {
        const children = new Set(container.get_children());
        for (let i = lm._windowSlots.length - 1; i >= 0; i--) {
            if (children.has(lm._windowSlots[i][4]))
                continue;
            lm._spatialDetached.push([i, lm._windowSlots[i]]);
            lm._windowSlots.splice(i, 1);
        }
    }

    // Gives back the slots dropped at engagement, once the container owns the
    // actor again. dnd reparents in _onAnimationComplete (dnd.js:518-521) and
    // emits drag-end straight after, so the slot is back before the frame that
    // follows the handoff. Entries whose actor never came back - a
    // cross-workspace drop destroys the preview instead - are left for
    // _restoreWorkspacesState to discard.
    _reattachDetachedSlots() {
        for (const view of this._getWsDisplay()?._workspacesViews ?? []) {
            for (const w of view._workspaces ?? []) {
                const container = w._container;
                const lm = container?.layout_manager;
                if (!lm?._spatialDetached?.length)
                    continue;
                // Pin dropped: upstream is solving for the live box again and
                // _windowSlots is its array, not ours to splice into. It also
                // rebuilt the layout, so the returning preview gets a slot on
                // its own.
                if (!lm._spatialRefSlots) {
                    lm._spatialDetached = [];
                    continue;
                }
                // Asked of the container, not of the actor: a cross-workspace
                // drop destroys the preview, and get_parent() on the disposed
                // wrapper is a Gjs-CRITICAL. Set membership never reaches C.
                const children = new Set(container.get_children());
                lm._spatialDetached = lm._spatialDetached.filter(([i, slot]) => {
                    if (!children.has(slot[4]))
                        return true;
                    lm._windowSlots.splice(
                        Math.min(i, lm._windowSlots.length), 0, slot);
                    return false;
                });
                container.queue_relayout();
            }
        }
    }

    // Runs the callback once the actor's geometry can be read back, i.e. once
    // it stops owing an allocation. Callers that only need to know a relayout
    // was queued have notify::allocation; this is for the ones that need the
    // answer.
    _afterAllocation(actor, callback) {
        this._cancelAllocationWait();

        if (!actor || actor.has_allocation()) {
            callback();
            return;
        }

        const fire = () => {
            this._cancelAllocationWait();
            callback();
        };

        const wait = {actor, allocationId: 0, timeoutId: 0};
        this._allocationWait = wait;
        wait.allocationId = actor.connect('notify::allocation', fire);
        // A relayout that lands on the geometry the actor already had clears
        // the debt without changing the box, and notify::allocation carries
        // the change, not the clearing. Waiting on it alone can wait forever.
        wait.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            wait.timeoutId = 0;
            fire();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelAllocationWait() {
        const wait = this._allocationWait;
        if (!wait)
            return;

        this._allocationWait = null;
        if (wait.allocationId)
            wait.actor.disconnect(wait.allocationId);
        if (wait.timeoutId)
            GLib.source_remove(wait.timeoutId);
    }

    _removeRestoreIdle() {
        if (this._restoreIdleId) {
            GLib.source_remove(this._restoreIdleId);
            this._restoreIdleId = 0;
        }
    }

    _removeEngageTimeout() {
        if (this._engageTimeoutId) {
            GLib.source_remove(this._engageTimeoutId);
            this._engageTimeoutId = 0;
        }
    }

    // FIXME downstream: the upstream "new-workspace indicator via drop" lives
    // exclusively in ThumbnailsBox (workspaceThumbnail.js:_dropPlaceholder +
    // Main.wm.insertWorkspace). We replicate it on the main WorkspacesView in
    // FitMode.ALL, which has *no* drop-to-create support upstream.
    //
    // Both _getWorkspaceIndexAt and _getInsertWorkspaceIndex consume the same
    // sorted rect array built by _collectWorkspaceRects().
    //
    // Rects come out in ZoomOutView-local coordinates: dnd.js hands
    // handleDragOver/acceptDrop a point already run through
    // target.transform_stage_point (dnd.js:344, 419), and vfunc_allocate
    // places the placeholder in the same space.
    _collectWorkspaceRects() {
        const mon = Main.layoutManager.monitors[
            Main.layoutManager.primaryIndex];
        const view = this._zoomOutView;
        if (!mon || !view)
            return {rects: [], monitor: null, spacing: 0};

        const display = this._getWsDisplay();
        let workspaces = null;
        const views = display?._workspacesViews;
        if (Array.isArray(views)) {
            for (const v of views) {
                if (v?._workspaces && v._workspaces.length > 0) {
                    workspaces = v._workspaces;
                    break;
                }
            }
        }
        const wsView = display?._workspacesView;
        if (!workspaces && wsView?._workspaces)
            workspaces = wsView._workspaces;
        if (!workspaces || workspaces.length === 0)
            return {rects: [], monitor: mon, spacing: 0};

        const rects = [];
        for (let i = 0; i < workspaces.length; i++) {
            const wsActor = workspaces[i];
            if (!wsActor || !wsActor.visible || !wsActor.metaWorkspace)
                continue;
            const [wx, wy] = wsActor.get_transformed_position();
            const [ww, wh] = wsActor.get_transformed_size();
            if (ww <= 1 || wh <= 1)
                continue;
            const [okTL, lx, ly] = view.transform_stage_point(wx, wy);
            const [okBR, rx, ry] = view.transform_stage_point(wx + ww, wy + wh);
            if (!okTL || !okBR)
                continue;
            rects.push({
                i: wsActor.metaWorkspace.index(),
                x: Math.round(lx), y: Math.round(ly),
                w: Math.round(rx - lx), h: Math.round(ry - ly),
            });
        }
        rects.sort((a, b) => a.i - b.i);

        // Measured off the rects, not read from a theme node: our patched
        // _getSpacing is what produced this layout.
        const spacing = rects.length > 1
            ? Math.max(0, rects[1].x - (rects[0].x + rects[0].w))
            : 0;

        if (DEBUG) {
            const key = rects.map(r => `${r.x}:${r.w}`).join(',');
            if (this._rectProbeKey !== key) {
                this._rectProbeKey = key;
                logTime('wsRects', JSON.stringify({
                    n: rects.length, spacing,
                    panel: rects[0] ? [rects[0].w, rects[0].h] : null,
                    x: rects.map(r => r.x),
                    gaps: rects.slice(1).map(
                        (r, k) => r.x - (rects[k].x + rects[k].w)),
                }));
            }
        }

        return {rects, monitor: mon, spacing};
    }

    // The horizontal cut mirrors upstream _withinWorkspace
    // (workspaceThumbnail.js:812-828): the outer WORKSPACE_CUT_SIZE of each
    // workspace belongs to the neighbouring insert zone, not to the workspace.
    _getWorkspaceIndexAt(x, y) {
        const {rects, monitor} = this._collectWorkspaceRects();
        if (!monitor || rects.length === 0) {
            logTime('_getWorkspaceIndexAt: no rects', {
                x: Math.round(x), y: Math.round(y),
            });
            return -1;
        }
        for (const r of rects) {
            // Exclusive lower bound like upstream (workspaceThumbnail.js:827):
            // with >= the boundary pixel is claimed by the insert zone and by
            // this one at the same time.
            const x1 = r.x + WORKSPACE_CUT_SIZE;
            const x2 = r.x + r.w - WORKSPACE_CUT_SIZE;
            if (x > x1 && x <= x2 && y >= r.y && y <= r.y + r.h) {
                logTime('_getWorkspaceIndexAt: HIT', {
                    wsIndex: r.i,
                    x: Math.round(x), y: Math.round(y),
                    rect: r,
                });
                return r.i;
            }
        }
        logTime('_getWorkspaceIndexAt: MISS', {
            x: Math.round(x), y: Math.round(y),
            rects,
        });
        return -1;
    }

    // Returns -1 if cursor is not in a "between workspaces" gap, otherwise
    // the workspace index that should be at the insertion position (i.e.,
    // Main.wm.insertWorkspace(index) will shift subsequent workspaces
    // rightward, matching upstream ThumbnailsBox semantics).
    //
    // Gated by Meta.prefs_get_dynamic_workspaces() - same condition the
    // upstream thumbnails check enforces (workspaceThumbnail.js:836).
    // Returns -1 when dynamic workspaces are off, mirroring upstream.
    //
    // Zone geometry follows _getPlaceholderTarget (workspaceThumbnail.js:780):
    // the zone before workspace k spans [k.x - spacing - CUT, k.x + CUT], so it
    // eats into both neighbours instead of being only the bare gap, and it
    // widens by the placeholder's footprint once engaged there.
    //
    // The widening is not optional padding: upstream allocates the placeholder
    // into the row, which pushes the workspace right by exactly that much, and
    // the term is what keeps the zone under the cursor afterwards. Any attempt
    // to add the reflow here has to keep it, or the zone escapes the cursor,
    // clears, and re-engages every frame.
    _getInsertWorkspaceIndex(x, y) {
        if (!Meta.prefs_get_dynamic_workspaces())
            return -1;
        const {rects, spacing} = this._collectWorkspaceRects();
        if (rects.length === 0)
            return -1;

        // Use the first rect's y-band as a shared vertical band - works
        // because in FitMode.ALL all workspaces share the same vertical band.
        const yTop = rects[0].y;
        const yBot = rects[0].y + rects[0].h;
        if (y < yTop || y > yBot)
            return -1;

        const engaged = this._dropInsertIndex;
        for (let k = 0; k < rects.length; k++) {
            const r = rects[k];
            let x1 = r.x - spacing - WORKSPACE_CUT_SIZE;
            const x2 = r.x + WORKSPACE_CUT_SIZE;
            // Nothing to the left of the first workspace to cut into.
            if (k === 0)
                x1 += spacing + WORKSPACE_CUT_SIZE;
            if (r.i === engaged)
                x1 -= PLACEHOLDER_WIDTH + spacing;
            if (x > x1 && x <= x2)
                return r.i;
        }

        // FIXME downstream: upstream has no insert-after-last zone - its loop
        // only builds insert-before zones (workspaceThumbnail.js:845-856).
        const last = rects[rects.length - 1];
        let afterX1 = last.x + last.w - WORKSPACE_CUT_SIZE;
        if (last.i + 1 === engaged)
            afterX1 -= PLACEHOLDER_WIDTH + spacing;
        if (x > afterX1)
            return last.i + 1;

        return -1;
    }

    // Returns the rect for the placeholder when the insert cursor is at
    // `insertIndex`, centered in the gap between workspace panels.
    //
    // FIXME downstream: upstream sizes the placeholder from its theme node via
    // allocate_preferred_size (workspaceThumbnail.js:1340). That size is meant
    // for thumbnails; against full-size FitMode.ALL workspaces we pick the height
    // from the workspace instead.
    _getInsertRect(insertIndex) {
        const {rects} = this._collectWorkspaceRects();
        if (rects.length === 0)
            return null;
        const PH_W = PLACEHOLDER_WIDTH;
        const PH_H = Math.round(rects[0].h / 3);
        if (insertIndex <= rects[0].i) {
            const wsH = rects[0].h;
            const centerY = rects[0].y + wsH / 2;
            return {
                index: rects[0].i,
                x: rects[0].x - PH_W / 2,
                y: Math.round(centerY - PH_H / 2),
                w: PH_W,
                h: PH_H,
            };
        }
        const last = rects[rects.length - 1];
        if (insertIndex > last.i) {
            const wsH = last.h;
            const centerY = last.y + wsH / 2;
            return {
                index: last.i + 1,
                x: last.x + last.w - PH_W / 2,
                y: Math.round(centerY - PH_H / 2),
                w: PH_W,
                h: PH_H,
            };
        }
        for (let k = 0; k < rects.length - 1; k++) {
            const left = rects[k];
            const right = rects[k + 1];
            if (insertIndex === right.i) {
                const gapCenterX = (left.x + left.w + right.x) / 2;
                const wsH = left.h;
                const centerY = left.y + wsH / 2;
                return {
                    index: right.i,
                    x: Math.round(gapCenterX - PH_W / 2),
                    y: Math.round(centerY - PH_H / 2),
                    w: PH_W,
                    h: PH_H,
                };
            }
        }
        return null;
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

    // FIXME downstream: the dynamic-workspace floor is upstream's, spelled
    // MIN_NUM_WORKSPACES = 2 in windowManager.js:42 and read only inside
    // WorkspaceTracker._checkWorkspaces (windowManager.js:273,286). That
    // method is the single authority: it runs on a BEFORE_REDRAW later after
    // any workspace change and is what adds and deletes workspaces.
    //
    // Bumping that number does not raise the floor, because the deletion loop
    // only holds it with a break, walking backwards:
    //
    //     for (i = lastIndex; i >= 0; i--) {
    //         if (workspaceManager.n_workspaces === MIN_NUM_WORKSPACES)
    //             break;
    //         if (emptyWorkspaces[i] && i !== lastEmptyIndex)
    //             workspaceManager.remove_workspace(...);
    //     }
    //
    // Coming from the end, the break fires while still inside the trailing
    // run of empty workspaces and never reaches an empty one in front of an
    // occupied one. At 2 that is unreachable; at 3, [empty, occupied, empty]
    // keeps its first workspace forever.
    //
    // So state the rule instead of guarding it: keep the occupied workspaces,
    // the active one, and the trailing empty run - grown until it meets the
    // floor - and remove the rest. The policy stays upstream's, one spare at
    // the end, so the floor only shows up when the count would fall short:
    //
    //     occupied   0   1   2   3   4
    //     upstream   2   2   3   4   5
    //     here       3   3   3   4   5
    //
    // At MIN 2 it reproduces upstream exactly, which is what makes it a
    // generalisation rather than a different rule.
    //
    // Ideal upstream fix: this loop, with MIN_NUM_WORKSPACES from GSettings.
    _patchMinWorkspaces() {
        if (!Meta.prefs_get_dynamic_workspaces())
            return;

        const tracker = Main.wm._workspaceTracker;
        const proto = tracker?.constructor.prototype;
        if (!proto || proto._spatialOrigCheckWorkspaces)
            return;

        let lastLine = '';

        proto._spatialOrigCheckWorkspaces = proto._checkWorkspaces;
        proto._checkWorkspaces = function () {
            const workspaceManager = global.workspace_manager;
            const time = global.get_current_time();
            let i;

            if (!Meta.prefs_get_dynamic_workspaces()) {
                this._checkWorkspacesId = 0;
                return GLib.SOURCE_REMOVE;
            }

            if (this._pauseWorkspaceCheck)
                return GLib.SOURCE_CONTINUE;

            // Verbatim from upstream (windowManager.js:235-264).
            const emptyWorkspaces = [];
            for (i = 0; i < this._workspaces.length; i++) {
                const lastRemoved = this._workspaces[i]._lastRemovedWindow;
                if ((lastRemoved &&
                     (lastRemoved.get_window_type() === Meta.WindowType.SPLASHSCREEN ||
                      lastRemoved.get_window_type() === Meta.WindowType.DIALOG ||
                      lastRemoved.get_window_type() === Meta.WindowType.MODAL_DIALOG)) ||
                    this._workspaces[i]._keepAliveId)
                    emptyWorkspaces[i] = false;
                else
                    emptyWorkspaces[i] = true;
            }

            const sequences = Shell.WindowTracker.get_default().get_startup_sequences();
            for (i = 0; i < sequences.length; i++) {
                const index = sequences[i].get_workspace();
                if (index >= 0 && index <= workspaceManager.n_workspaces)
                    emptyWorkspaces[index] = false;
            }

            const windows = global.get_window_actors();
            for (i = 0; i < windows.length; i++) {
                const actor = windows[i];
                const win = actor.get_meta_window();

                if (win.is_on_all_workspaces())
                    continue;

                const workspaceIndex = win.get_workspace().index();
                emptyWorkspaces[workspaceIndex] = false;
            }

            // Index the trailing empty run starts at. Read before the active
            // workspace is protected, as upstream does, so that being parked
            // on an empty workspace does not move it.
            const lastEmptyIndex = emptyWorkspaces.lastIndexOf(false) + 1;
            const activeIndex = workspaceManager.get_active_workspace_index();

            // X occupied, . empty, (parentheses) active. Read here because the
            // next line overwrites the active workspace's own reading.
            const before = DEBUG
                ? emptyWorkspaces
                    .map((empty, index) => {
                        const cell = empty ? '.' : 'X';
                        return index === activeIndex ? `(${cell})` : ` ${cell} `;
                    })
                    .join('')
                : '';

            emptyWorkspaces[activeIndex] = false;

            const keep = emptyWorkspaces.map(empty => !empty);
            let kept = keep.reduce((n, k) => n + (k ? 1 : 0), 0);

            // Grow the trailing run: one empty workspace at the end, plus
            // whatever the floor is still short of. The active workspace can
            // sit inside that run, so already-kept indices are skipped rather
            // than counted twice.
            for (i = lastEmptyIndex; kept < MIN_WORKSPACES || i === lastEmptyIndex; i++) {
                if (i === keep.length) {
                    workspaceManager.append_new_workspace(false, time);
                    keep.push(false);
                }
                if (!keep[i]) {
                    keep[i] = true;
                    kept++;
                }
            }

            const appended = keep.length - emptyWorkspaces.length;
            const removed = [];

            // From the end, so the indices still to visit stay valid.
            for (i = keep.length - 1; i >= 0; i--) {
                if (!keep[i]) {
                    removed.unshift(i);
                    workspaceManager.remove_workspace(this._workspaces[i], time);
                }
            }

            // Only when the reading changes - this runs several times a second.
            if (DEBUG) {
                const line = `${before} lastEmpty=${lastEmptyIndex}` +
                    ` +${appended} -[${removed.join(',')}]` +
                    ` => n=${keep.length - removed.length}`;
                if (line !== lastLine) {
                    lastLine = line;
                    logTime('_checkWorkspaces', line);
                }
            }

            this._checkWorkspacesId = 0;
            return GLib.SOURCE_REMOVE;
        };

        this._minWorkspacesProto = proto;
        this._rebindWorkspaceCheck(tracker);
        logTime('_patchMinWorkspaces', {min: MIN_WORKSPACES});
    }

    // FIXME downstream: _queueCheckWorkspaces binds the method at queue time
    // (`laters.add(BEFORE_REDRAW, this._checkWorkspaces.bind(this))`,
    // windowManager.js:337) and will not queue a second one while
    // _checkWorkspacesId is set. A check already in flight when we swap the
    // method therefore still runs the old one, and clears the id on its way
    // out, so nothing re-queues until the next window or workspace event.
    //
    // That only matters to a replacement, and it mattered to this one: the
    // floor first took effect on whatever event came next, so the third
    // workspace appeared only once the first had been used.
    //
    // Ideal upstream fix: bind once in the constructor, so replacing the
    // method is not a race.
    _rebindWorkspaceCheck(tracker) {
        if (!tracker)
            return;

        if (tracker._checkWorkspacesId !== 0) {
            global.compositor.get_laters().remove(tracker._checkWorkspacesId);
            tracker._checkWorkspacesId = 0;
            logTime('_rebindWorkspaceCheck: dropped a pending check');
        }
        tracker._queueCheckWorkspaces();
    }

    _restoreMinWorkspaces() {
        const proto = this._minWorkspacesProto;
        if (!proto)
            return;

        proto._checkWorkspaces = proto._spatialOrigCheckWorkspaces;
        delete proto._spatialOrigCheckWorkspaces;
        this._minWorkspacesProto = null;
        this._rebindWorkspaceCheck(Main.wm._workspaceTracker);
        logTime('_restoreMinWorkspaces');
    }

    _restoreWorkspacesState() {
        this._reattachDetachedSlots();
        const ws = this._getWsDisplay();
        for (const view of ws?._workspacesViews ?? []) {
            if (view._origUpdateWorkspacesState) {
                view._updateWorkspacesState = view._origUpdateWorkspacesState;
                view._origUpdateWorkspacesState = null;
                // The accent raised one workspace above its siblings; put the
                // row back in workspace order, the way upstream restacks it
                // after a reorder (workspacesView.js:119-122).
                view._workspaces?.forEach(
                    (w, i) => view.set_child_at_index(w, i));
                view._updateWorkspacesState();
            }
            for (const w of view._workspaces ?? []) {
                const container = w._container;
                const lm = container?.layout_manager;
                if (lm && lm._origGetWindowSlots !== undefined) {
                    lm._getWindowSlots = lm._origGetWindowSlots;
                    lm._origGetWindowSlots = undefined;
                    lm._spatialRefBox = undefined;
                    lm._spatialRefSlots = undefined;
                    lm._spatialRefLayout = undefined;
                    lm._spatialDetached = undefined;
                }
            }
        }
    }

    // FIXME downstream: the hot corner is hardcoded to the monitor's top-left.
    // LayoutManager._updateHotCorners builds every HotCorner at
    // `cornerX = monitor.x` (layout.js:450-451), and HotCorner.setBarrierSize
    // welds an L of two barriers to that origin, growing +X and +Y
    // (layout.js:1221-1231). Nothing in between is configurable.
    //
    // With Activities moved to the panel's center by _patchPanelLayout, the
    // corner that opens the overview and the button that opens the overview
    // sat at opposite ends of the screen. This puts the trigger back under
    // the button.
    //
    // Only the horizontal barrier survives the move. Upstream's vertical leg
    // presses against the left screen edge; at mid-screen there is no edge
    // behind it, so it would just be a floating wall that traps the pointer
    // in the top band. A mid-edge trigger is an edge, not a corner.
    //
    // Barrier `directions` name the directions in which crossing is allowed,
    // so POSITIVE_Y (upstream's own value here) is what makes an upward push
    // build pressure against the top of the screen.
    //
    // The ripple moves with it - origin, pivot and shape. Upstream's wave is
    // corner-shaped in all three, and none of them survives the move alone.
    //
    // Ideal upstream fix: let the hot corner's position be chosen - a
    // GSettings key, or deriving it from wherever 'activities' sits in
    // sessionMode - instead of assuming the top-left corner.
    _patchHotCorner() {
        const proto = HotCorner.prototype;
        if (proto._spatialOrigSetBarrierSize)
            return;

        proto._spatialOrigSetBarrierSize = proto.setBarrierSize;
        proto.setBarrierSize = function (size) {
            if (this._verticalBarrier) {
                this._pressureBarrier.removeBarrier(this._verticalBarrier);
                this._verticalBarrier.destroy();
                this._verticalBarrier = null;
            }

            if (this._horizontalBarrier) {
                this._pressureBarrier.removeBarrier(this._horizontalBarrier);
                this._horizontalBarrier.destroy();
                this._horizontalBarrier = null;
            }

            if (size <= 0)
                return;

            const width = Math.round(this._monitor.width * HOT_EDGE_WIDTH_FRACTION);
            const centerX = Math.round(this._monitor.x + this._monitor.width / 2);
            const x = centerX - Math.round(width / 2);

            // _toggleOverview plays the ripple at this._x (layout.js:1253),
            // so move it too or the feedback stays in the old corner.
            this._x = centerX;

            // Ripples places the wave by pivot point plus a matching
            // translation (ripples.js:22-36,63). HotCorner pivots at (0, 0)
            // so a quarter disc blooms away from the screen corner; centered
            // on the top edge that same pivot drags the wave in from the
            // upper left. (0.5, 0) anchors it to the edge and centers it, and
            // .spatial-hot-edge-ripple swaps the quarter disc for a half one
            // so the shape matches the anchor.
            const ripples = this._ripples;
            if (ripples && ripples._px !== 0.5) {
                ripples._px = 0.5;
                ripples._py = 0.0;
                for (const r of
                    [ripples._ripple1, ripples._ripple2, ripples._ripple3]) {
                    r?.set_pivot_point(0.5, 0.0);
                    r?.add_style_class_name('spatial-hot-edge-ripple');
                }
            }

            this._horizontalBarrier = new Meta.Barrier({
                backend: global.backend,
                x1: x, x2: x + width,
                y1: this._monitor.y, y2: this._monitor.y,
                directions: Meta.BarrierDirection.POSITIVE_Y,
            });
            this._pressureBarrier.addBarrier(this._horizontalBarrier);
            logTime('hot zone', {x, width, centerX, y: this._monitor.y});
        };

        this._hotCornerPatched = true;
        Main.layoutManager._updateHotCorners();
        logTime('_patchHotCorner: hot corner -> top center');
    }

    _restoreHotCorner() {
        if (!this._hotCornerPatched)
            return;

        const proto = HotCorner.prototype;
        proto.setBarrierSize = proto._spatialOrigSetBarrierSize;
        delete proto._spatialOrigSetBarrierSize;

        this._hotCornerPatched = false;
        Main.layoutManager._updateHotCorners();
        logTime('_restoreHotCorner');
    }

    _getWorkspaceIndicators() {
        // ActivitiesButton adds exactly one child, the WorkspaceIndicators box
        // (panel.js:211).
        return Main.panel?.statusArea?.activities?.get_first_child() ?? null;
    }

    // FIXME downstream: WorkspaceDot.scaleIn/scaleOutAndDestroy (panel.js:
    // 107-131) animate scale_x/scale_y only. Scale is a paint-time transform;
    // it never reaches vfunc_get_preferred_width (panel.js:91-94), which sizes
    // the dot purely from expansion * widthMultiplier. So the BoxLayout keeps
    // allocating a dying dot its full width for the whole 500ms and reclaims
    // it in one step inside destroy().
    //
    // Measured in the nested shell, removing a workspace (4 -> 3 dots):
    // scale_x runs 1.00 -> 0.00 while the dot's preferred width stays 8px, so
    // the row holds a hole the dot no longer paints into; at +540ms destroy()
    // fires and the row snaps 13px (8px dot + 5px BoxLayout spacing). With
    // Activities in _centerBox that snap is halved into a 6px sideways jump of
    // the whole row, because Panel.vfunc_allocate centers it (panel.js:512).
    //
    // The fix belongs in vfunc_get_preferred_width, but it cannot go there
    // from an extension: GJS wires vfuncs into the class vtable at
    // GObject.registerClass time, so replacing prototype.
    // vfunc_get_preferred_width afterwards is silently ignored. Verified in
    // the nested shell - the override never ran, preferred width stayed 8px
    // across a full scale_x 1.00 -> 0.00 sweep. So we drive set_width from
    // notify::scale-x instead, which reaches the same layout input by the only
    // route an extension has.
    //
    // Ideal upstream fix: multiply the scale factor into
    // WorkspaceDot.vfunc_get_preferred_width and queue_relayout on
    // notify::scale-x, so layout and paint share one source of truth. That
    // also drops the set_width dance below.
    _patchWorkspaceDots() {
        const box = this._getWorkspaceIndicators();
        const dot = box?.get_first_child();
        if (!dot)
            return;

        const proto = Object.getPrototypeOf(dot);
        if (proto._spatialOrigScaleIn)
            return;

        proto._spatialOrigScaleIn = proto.scaleIn;
        proto._spatialOrigScaleOutAndDestroy = proto.scaleOutAndDestroy;

        // The gap between dots is the box's, and one spacing serves every gap,
        // so nothing on a dying dot can shrink its own - Clutter clamps margins
        // at >= 0. Half on each child leaves every gap the same width (half +
        // half) and makes it a per-dot property, which syncWidth then drives
        // from the same scale as the width.
        //
        // Read from the theme node, not from the layout manager: we zero the
        // manager's copy, and St re-applies the CSS one on every style change.
        const readSpacing = () => box.get_theme_node().get_length('spacing');
        this._dotBox = box;
        this._dotHalfSpacing = readSpacing() / 2;
        this._dotLayout = box.layout_manager;
        this._dotOrigSpacing = this._dotLayout.spacing;
        this._dotLayout.spacing = 0;

        const syncMargin = dot => {
            const margin = this._dotHalfSpacing * dot.scale_x;
            dot.set({margin_start: margin, margin_end: margin});
        };
        // The dots already in the box never run scaleIn, so they get their
        // margin here; a settled dot is at scale_x 1 and one mid-animation is
        // wherever its ease has reached.
        const syncAllMargins = () => box.get_children().forEach(syncMargin);
        syncAllMargins();

        this._dotStyleChangedId = box.connect('style-changed', () => {
            this._dotHalfSpacing = readSpacing() / 2;
            this._dotLayout.spacing = 0;
            syncAllMargins();
        });

        // Re-derived every frame rather than pinned once: _recalculateDots
        // calls scaleIn/scaleOutAndDestroy before _updateExpansion
        // (panel.js:158-176), so the natural width at animation start is stale
        // - a dot born as the active one is 8px here and 26px a tick later.
        // Clearing the override first is what makes get_preferred_width report
        // the current expansion * widthMultiplier instead of our own value.
        const syncWidth = dot => {
            dot.set_width(-1);
            const [, natWidth] = dot.get_preferred_width(-1);
            dot.set_width(Math.round(natWidth * dot.scale_x));
            syncMargin(dot);
        };
        const trackWidth = dot =>
            dot.connect('notify::scale-x', () => syncWidth(dot));

        proto.scaleIn = function () {
            this.set({scale_x: 0, scale_y: 0});
            const id = trackWidth(this);
            syncWidth(this);
            this.ease({
                duration: WORKSPACE_DOT_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                scale_x: 1.0,
                scale_y: 1.0,
                onStopped: () => {
                    this.disconnect(id);
                    this.set_width(-1);
                },
            });
        };

        // EASE_IN_CUBIC, not upstream's EASE_OUT_CUBIC. The removal is the
        // reversal of scaleIn, so it wants the mirrored curve; sharing
        // EASE_OUT_CUBIC front-loads a shrink instead. Measured with upstream's
        // curve: width fell 8px -> 1px inside the first 300ms and held ~0 for
        // the remaining 200ms - motion, then a stall the eye reads as the row
        // having finished early.
        proto.scaleOutAndDestroy = function () {
            this._destroying = true;
            trackWidth(this);
            this.ease({
                duration: WORKSPACE_DOT_DURATION,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                scale_x: 0.0,
                scale_y: 0.0,
                onComplete: () => this.destroy(),
            });
        };

        this._workspaceDotProto = proto;
        logTime('_patchWorkspaceDots: dot width follows scale');
    }

    _restoreWorkspaceDots() {
        const proto = this._workspaceDotProto;
        if (!proto)
            return;

        proto.scaleIn = proto._spatialOrigScaleIn;
        proto.scaleOutAndDestroy = proto._spatialOrigScaleOutAndDestroy;
        delete proto._spatialOrigScaleIn;
        delete proto._spatialOrigScaleOutAndDestroy;

        if (this._dotStyleChangedId) {
            this._dotBox.disconnect(this._dotStyleChangedId);
            this._dotStyleChangedId = 0;
        }
        // The layout manager is the shell's own and outlives us.
        if (this._dotLayout) {
            this._dotLayout.spacing = this._dotOrigSpacing;
            this._dotLayout = null;
        }
        this._dotBox = null;

        for (const dot of this._getWorkspaceIndicators()?.get_children() ?? [])
            dot.set({width: -1, margin_start: 0, margin_end: 0});

        this._workspaceDotProto = null;
        logTime('_restoreWorkspaceDots');
    }

    // FIXME downstream: panel item positions are hardcoded in sessionMode.js
    // ('user' mode: `left: ['activities'], center: ['dateMenu']`,
    // sessionMode.js:97-99). There is no GSettings key, no dconf knob, no
    // extension API to swap them, so this reparents the indicators' containers
    // between Panel._leftBox and Panel._centerBox (panel.js:446-451), neither
    // of which is exported on the Panel class.
    //
    // sessionMode.connect('updated') re-runs Panel._updatePanel on every mode
    // change (lock screen, initial setup, logout), which re-inserts each
    // container into the box sessionMode declares for it. _reapplyPanelLayout
    // re-moves them after the dust settles.
    //
    // Ideal upstream fix: make panel.left/center/right configurable via
    // GSettings, with sessionMode.js reading the position for each role
    // rather than hardcoding it.
    _patchPanelLayout() {
        if (this._panelPatched)
            return;

        const panel = Main.panel;
        if (!panel?._leftBox || !panel?._centerBox)
            return;

        const dateMenu = panel.statusArea.dateMenu;
        const activities = panel.statusArea.activities;

        // ActivitiesButton has no menu (panel.js:201, dontCreateMenu=true) and
        // DateMenuButton aligns at 0.5 (dateMenu.js:863), so neither carries a
        // position-dependent menu anchor. The geometry is not neutral though:
        // at the left edge the clock's ButtonBox hpadding becomes a visible
        // gap, which .spatial-clock-left cancels.
        if (dateMenu?.container) {
            const parent = dateMenu.container.get_parent();
            if (parent)
                parent.remove_child(dateMenu.container);
            panel._leftBox.insert_child_at_index(dateMenu.container, 0);
            dateMenu.add_style_class_name('spatial-clock-left');
            this._detachClockIndicatorPad(dateMenu);
        }

        if (activities?.container) {
            const parent = activities.container.get_parent();
            if (parent)
                parent.remove_child(activities.container);
            panel._centerBox.insert_child_at_index(activities.container, 0);
        }

        // Upstream _updatePanel sets this from
        // `panel.left.includes('dateMenu')` (panel.js:641-647). Follow the
        // same rule so notification banners line up under the new clock side.
        if (dateMenu?.container) {
            this._origBannerAlignment = Main.messageTray.bannerAlignment;
            Main.messageTray.bannerAlignment = Clutter.ActorAlign.START;
        }

        this._sessionModeUpdatedId = Main.sessionMode.connect(
            'updated', () => this._reapplyPanelLayout());

        this._panelPatched = true;
        logTime('_patchPanelLayout: clock -> left, activities -> center');
    }

    _reapplyPanelLayout() {
        const panel = Main.panel;
        if (!panel?._leftBox || !panel?._centerBox)
            return;

        const dateMenu = panel.statusArea.dateMenu;
        const activities = panel.statusArea.activities;

        if (dateMenu?.container) {
            const leftBox = panel._leftBox;
            const parent = dateMenu.container.get_parent();
            if (parent && parent !== leftBox) {
                parent.remove_child(dateMenu.container);
                leftBox.insert_child_at_index(dateMenu.container, 0);
            }
            dateMenu.add_style_class_name('spatial-clock-left');
            this._detachClockIndicatorPad(dateMenu);
        }

        if (activities?.container) {
            const centerBox = panel._centerBox;
            const parent = activities.container.get_parent();
            if (parent && parent !== centerBox) {
                parent.remove_child(activities.container);
                centerBox.insert_child_at_index(activities.container, 0);
            }
        }

        if (dateMenu?.container)
            Main.messageTray.bannerAlignment = Clutter.ActorAlign.START;
    }

    _restorePanelLayout() {
        if (!this._panelPatched)
            return;

        if (this._sessionModeUpdatedId) {
            Main.sessionMode.disconnect(this._sessionModeUpdatedId);
            this._sessionModeUpdatedId = 0;
        }

        const panel = Main.panel;
        const dateMenu = panel?.statusArea.dateMenu;
        const activities = panel?.statusArea.activities;

        if (dateMenu?.container) {
            this._reattachClockIndicatorPad(dateMenu);
            const parent = dateMenu.container.get_parent();
            if (parent)
                parent.remove_child(dateMenu.container);
            panel?._centerBox?.insert_child_at_index(dateMenu.container, 0);
            dateMenu.remove_style_class_name('spatial-clock-left');
        }

        if (activities?.container) {
            const parent = activities.container.get_parent();
            if (parent)
                parent.remove_child(activities.container);
            panel?._leftBox?.insert_child_at_index(activities.container, 0);
        }

        if (this._origBannerAlignment !== undefined) {
            Main.messageTray.bannerAlignment = this._origBannerAlignment;
            this._origBannerAlignment = undefined;
        } else {
            Main.messageTray.bannerAlignment = Clutter.ActorAlign.CENTER;
        }

        this._panelPatched = false;
        logTime('_restorePanelLayout: clock -> center, activities -> left');
    }

    // FIXME downstream: DateMenuButton balances the messages indicator with an
    // empty St.Widget (dateMenu.js:871-883). The pad copies the indicator's
    // size and visibility and goes into .clock-display-box on the side away
    // from it, so the dot appearing adds the same width to both ends and the
    // .clock label does not slide. Centered - where upstream puts the clock -
    // that is the whole point of the pad.
    //
    // _patchPanelLayout docks the clock in _leftBox, which Panel allocates
    // against the start edge of the screen (panel.js:518-523, mirrored under
    // RTL). There the pad has nothing left to balance: it sits between the
    // screen edge and the pill, and every notification pushes the pill inward
    // by the dot's width plus the box's 2px spacing until the dot clears.
    // Dropping the pad leaves the pill anchored and lets the box grow inward,
    // on the indicator's side. Which side that is follows the text direction,
    // so the pad is found by elimination rather than by child index.
    //
    // Ideal upstream fix: tie the pad to the clock actually being centered.
    _detachClockIndicatorPad(dateMenu) {
        if (this._clockIndicatorPad)
            return;

        const box = dateMenu?._clockDisplay?.get_parent();
        const pad = box?.get_children().find(child =>
            child !== dateMenu._clockDisplay && child !== dateMenu._indicator);
        if (!pad)
            return;

        box.remove_child(pad);
        this._clockIndicatorPad = pad;
        logTime('_detachClockIndicatorPad: clock indicator pad removed');
    }

    _reattachClockIndicatorPad(dateMenu) {
        const pad = this._clockIndicatorPad;
        this._clockIndicatorPad = null;
        if (!pad || pad.get_parent())
            return;

        // Index 0 is where _init put it; the pad keeps its size constraint and
        // visibility binding across the detach, so re-inserting is enough.
        dateMenu?._clockDisplay?.get_parent()?.insert_child_at_index(pad, 0);
    }

    _getControls() {
        return Main.overview?._overview?.controls ?? null;
    }

    _getWsDisplay() {
        return this._getControls()?._workspacesDisplay ?? null;
    }

    _isInAppGrid() {
        const controls = this._getControls();
        const params = controls?._stateAdjustment?.getStateTransitionParams?.();
        return params?.finalState === ControlsState.APP_GRID;
    }

    // _spatialEngaged alone is not enough: the overview can transition into the
    // app grid mid-drag, and the layout patches have to yield when it does.
    _spatialLayoutActive() {
        return this._spatialEngaged && !this._isInAppGrid();
    }
}
