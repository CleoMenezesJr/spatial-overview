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
import {Workspace, WorkspaceLayout} from 'resource:///org/gnome/shell/ui/workspace.js';

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
// FIXME downstream: the active pill is one WorkspaceDot widened by
// widthMultiplier (panel.js:91-94), and upstream picks that multiplier in
// three flat steps - 3.625 up to 2 dots, 3.25 up to 5, 2.75 beyond
// (panel.js:182-189). The dot is 8px (.workspace-dot min-width 0.5455em,
// gnome-shell-dark.css:1834-1838), so two workspaces give a 29px pill in a
// 42px row, and the row only reaches 100px at seven dots.
//
// Measured in the mockup on issue #3: a 58px pill against that same 8px dot,
// i.e. multiplier 7.25, asked to "reach the current pill size when you get to
// e.g. 7 workspaces". A 0.9 step per dot joins 7.25 to upstream's 2.75 at
// seven dots, where the row is 100px either way.
//
// Ideal upstream fix: this ramp inside _updateExpansion, in place of the
// steps.
const WORKSPACE_DOT_WIDTH_MAX = 7.25;
const WORKSPACE_DOT_WIDTH_MIN = 2.75; // panel.js:188
const WORKSPACE_DOT_WIDTH_STEP = 0.9;
// Dots that still get the full width, before the step starts.
const WORKSPACE_DOT_WIDTH_PLATEAU = 2;
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

        // Parented by _installBackdrop, not added here. This view is the last
        // child of overviewGroup because _pickTargetActor walks up from the
        // actor under the pointer (dnd.js:302), so it only collects
        // handleDragOver while it is above the workspaces - and a child of it
        // is painted above them too.
        this._backdrop = new St.Widget({
            style_class: 'zoom-out-backdrop',
            reactive: false,
            opacity: 0,
        });

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
        // overviewGroup allocates its children at their own preferred size,
        // and a St.Widget with no children prefers 0x0. Same monitor this
        // view's vfunc_get_preferred_width answers with.
        const mon = Main.layoutManager.monitors[
            Main.layoutManager.primaryIndex];
        if (mon)
            this._backdrop.set_size(mon.width, mon.height);
        this._backdrop.visible = true;
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
                this._backdrop.visible = false;
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
        this._progressSignalId = null;
        this._fitModeNotifyId = 0;
        this._fitModeNotifyAdj = null;
        this._restoreIdleId = 0;
        this._engageTimeoutId = 0;
        this._snapBackRetarget = null;
        this._spatialEngaged = false;
        this._dropInsertIndex = -1;
        this._dropWorkspaceIndex = -1;
        this._sessionModeUpdatedId = 0;
        this._minWorkspacesProto = null;
        this._panelPatched = false;
        this._workspaceCollectionBlocked = false;
        this._activitiesCheckedPatched = false;
        this._clockIndicatorPad = null;
        this._workspaceDotProto = null;
        this._workspaceIndicatorsProto = null;
        this._dotBox = null;
        this._dotLayout = null;
        this._dotOrigSpacing = 0;
        this._dotHalfSpacing = 0;
        this._dotStyleChangedId = 0;
        this._hotCornerPatched = false;

        this._patchPanelLayout();
        this._patchActivitiesChecked();
        this._patchWorkspaceDots();
        this._patchWorkspaceDotWidth();
        this._patchHotCorner();
        this._patchPreviewActivate();
        this._patchFitAllLayout();

        this._zoomOutView = new ZoomOutView();
        this._zoomOutView._extension = this;
        Main.layoutManager.overviewGroup.add_child(this._zoomOutView);
        this._installBackdrop();

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
        // The zoom-in after a drag can outlive the overview: clicking a window
        // preview while it runs activates it (workspace.js:1393-1397) and
        // that hides the overview from under us. The leave animation reads the
        // workspace geometry, and in FitMode.ALL that geometry is the shrunken
        // one.
        this._overviewHidingId = Main.overview.connect('hiding', () => {
            if (this._spatialEngaged)
                this._leaveFitAll({animate: false});
        });
    }

    // Index 0: painted before everything the overview draws, so the row is in
    // front of it. What it still darkens is the wallpaper - a translucent quad
    // composites over whatever was drawn before it, not only over its own
    // siblings, and the wallpaper is in global.window_group (layout.js:319-321),
    // below uiGroup.
    _installBackdrop() {
        Main.layoutManager.overviewGroup.insert_child_at_index(
            this._zoomOutView._backdrop, 0);
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
            // A foreign strategy places by proportion, not by row and column,
            // so it has no spacing of ours to scale.
            if (!self._spatialEngaged || !this._layoutStrategy ||
                !this._workarea || self._strategyOwnsGeometry(this))
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

        // Both of these answer for a preview that may be born, or re-asked,
        // long after the zoom settled - a window opened while fit-all is up
        // builds its WindowPreview then, and its constructor calls
        // _updateIconScale on the spot (windowPreview.js:227). Pushing the
        // floating chrome from the zoom's own frames reaches neither.
        this._origUpdateIconScale = WindowPreview.prototype._updateIconScale;
        const origUpdateIconScale = this._origUpdateIconScale;
        WindowPreview.prototype._updateIconScale = function () {
            origUpdateIconScale.call(this);
            const fitMode = self._floatingFitMode();
            if (fitMode === FitMode.SINGLE)
                return;
            // Upstream's answer for the overview state, faded by the zoom:
            // it re-runs from here on the next call, so this cannot compound.
            const scale = this._icon.scale_x * (1 - fitMode);
            this._icon.set({scale_x: scale, scale_y: scale});
        };

        // FIXME downstream: the only geometry signal WorkspaceLayout takes is
        // the MetaWindow's size-changed (workspace.js:801). A window that only
        // moves never reaches _needsLayout, and nothing else re-reads where it
        // is - right for the spread, which places windows by its own strategy
        // and ignores where they really are, and wrong for a layout that draws
        // them where they really are.
        //
        // WindowPreview already emits what is needed: its size-changed fires
        // on every bounding-box change, move included (windowPreview.js:
        // 86-98). Nothing in workspace.js listens to it.
        //
        // Ideal upstream fix: let WorkspaceLayout follow the preview's
        // size-changed, so the floating layout is as live as the spread.
        this._origAddWindow = WorkspaceLayout.prototype.addWindow;
        const origAddWindow = this._origAddWindow;
        WorkspaceLayout.prototype.addWindow = function (window, metaWindow) {
            origAddWindow.call(this, window, metaWindow);
            if (self._spatialLayoutActive())
                self._trackFloatingGeometry(this, window);
        };

        this._origSyncOverlay = WorkspaceLayout.prototype._syncOverlay;
        const origSyncOverlay = this._origSyncOverlay;
        // FIXME downstream: overlayEnabled is not a plain flag. Its setter
        // calls showOverlay() on the spot whenever the pointer is on the
        // preview or it holds the key focus (windowPreview.js:500-503), so
        // letting the original answer first and correcting it afterwards puts
        // the caption and the close button on screen once per pass - and the
        // _updateWorkspacesState hook runs a pass on every frame of the zoom.
        //
        // Ideal upstream fix: let a WorkspaceLayout in FitMode.ALL say that
        // its previews take no overlay, instead of deriving it from the state
        // adjustment alone.
        WorkspaceLayout.prototype._syncOverlay = function (preview) {
            if (self._floatingFitMode() > FitMode.SINGLE)
                preview.overlayEnabled = false;
            else
                origSyncOverlay.call(this, preview);
        };

        // FIXME downstream: _doRemoveWindow freezes the layout and thaws it
        // only once the pointer has held still for 750ms away from the
        // workspace (workspace.js:1147-1183), because in the spread every
        // window left behind moves to close the gap and upstream will not do
        // that under the pointer. While the layout is frozen vfunc_allocate
        // skips the slot pass entirely (workspace.js:670), so nothing here
        // re-reads where the windows are.
        //
        // Dragging a window to another workspace is the ordinary way to use
        // fit-all, and it is exactly the gesture that leaves the pointer on
        // the workspace it just emptied - the freeze can outlast the whole
        // interaction. There is nothing for it to protect either: the
        // floating layout draws every window where it really is, so a window
        // leaving moves none of the others.
        //
        // Ideal upstream fix: freeze against the reshuffle, not against the
        // removal - a layout that does not reflow has nothing to defer.
        this._origDoRemoveWindow = Workspace.prototype._doRemoveWindow;
        const origDoRemoveWindow = this._origDoRemoveWindow;
        Workspace.prototype._doRemoveWindow = function (metaWin) {
            origDoRemoveWindow.call(this, metaWin);
            if (!self._spatialLayoutActive())
                return;

            if (this._layoutFrozenId > 0) {
                GLib.source_remove(this._layoutFrozenId);
                this._layoutFrozenId = 0;
            }
            // The setter calls layout_changed on the way down
            // (workspace.js:936), which is what re-reads the row.
            this._container.layout_manager.layout_frozen = false;
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
        if (this._origUpdateIconScale)
            WindowPreview.prototype._updateIconScale = this._origUpdateIconScale;
        if (this._origSyncOverlay)
            WorkspaceLayout.prototype._syncOverlay = this._origSyncOverlay;
        if (this._origAddWindow)
            WorkspaceLayout.prototype.addWindow = this._origAddWindow;
        if (this._origDoRemoveWindow)
            Workspace.prototype._doRemoveWindow = this._origDoRemoveWindow;
        this._origGetFirstFitAllWorkspaceBox = null;
        this._origGetSpacing = null;
        this._origGetWindowSlots = null;
        this._origAddWindow = null;
        this._origUpdateIconScale = null;
        this._origSyncOverlay = null;
        this._origDoRemoveWindow = null;
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

        // The adjustment is the shell's own. Disabling while in fit-all
        // would leave it there with nothing left to ease it back.
        const fitAdj = this._getWsDisplay()?._fitModeAdjustment;
        if (this._spatialEngaged && fitAdj) {
            fitAdj.remove_transition('value');
            fitAdj.value = FitMode.SINGLE;
        }

        this._disconnectFitModeNotify();
        this._removeRestoreIdle();
        this._removeEngageTimeout();
        this._stopSnapBackRetarget();
        this._spatialEngaged = false;
        this._restoreWorkspacesState();
        this._restorePreviewActivate();
        this._restoreFitAllLayout();
        this._restorePanelLayout();
        this._restoreActivitiesChecked();
        this._restoreWorkspaceDotWidth();
        this._restoreWorkspaceDots();
        this._restoreHotCorner();
        this._dragActive = false;

        if (this._zoomOutView) {
            // Not a child of the view, so its destroy does not take it.
            this._zoomOutView._backdrop.destroy();
            this._zoomOutView.destroy();
            this._zoomOutView = null;
        }
    }

    _onDragBegin(metaWindow) {
        logTime('_onDragBegin ENTER (zoom-out held back)');
        this._dragActive = true;
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
                    // difference is the jump.
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
                    // afford that: nothing relayouts a workspace mid-drag. Here
                    // every drag end runs the 400ms zoom-in, so the snap-back
                    // starts against a container that is still growing and
                    // would land on the size it had at the drop.
                    //
                    // Re-aim it instead, once per allocation of the container
                    // it returns to: the tween keeps its progress and only its
                    // end moves. notify::allocation and not a frame callback -
                    // get_width() on an actor still owing an allocation answers
                    // with its preferred width, which for WorkspaceLayout is the
                    // whole workarea (workspace.js:607-609). The 250ms tween
                    // ends inside the zoom; from there the container lays the
                    // preview out itself.
                    //
                    // Ideal upstream fix: let a drag origin whose geometry is
                    // animating have the snap-back follow it, the way a drop
                    // target could invalidate a stale hover.
                    this._origAnimateDragEnd = draggable._animateDragEnd;
                    const origAnimateDragEnd = this._origAnimateDragEnd;
                    draggable._animateDragEnd = function (eventTime, params) {
                        const parent = this._dragOrigParent;
                        const zooming = !!self._getWsDisplay()
                            ?._fitModeAdjustment?.get_transition('value');
                        // dnd holds its grab until _dragComplete (dnd.js:
                        // 543-544), so a second Esc or the button release
                        // reaches _cancelDrag again mid-tween (dnd.js:569-570,
                        // 450). Its ease removes this one's transitions, which
                        // stops them unfinished, and onStopped reparents the
                        // clone where it stands (environment.js:161-163,
                        // dnd.js:500-502). The tween running already goes to
                        // the same place.
                        if (self._snapBackRetarget) {
                            logTime('snap-back already running');
                            return;
                        }

                        origAnimateDragEnd.call(this, eventTime, params);
                        if (!zooming || !parent || !this._dragActor)
                            return;

                        logTime('snap-back follows the zoom');
                        const retarget = () => {
                            const actor = this._dragActor;
                            if (!actor || !parent.has_allocation())
                                return;
                            const [x, y, scale] = this._getRestoreLocation();
                            // _restoreDragActor fades in at the location and
                            // eases opacity alone (dnd.js:481-491).
                            if (!('x' in params)) {
                                actor.set_position(x, y);
                                actor.set_scale(scale, scale);
                                return;
                            }
                            actor.get_transition('x')?.set_to(x);
                            actor.get_transition('y')?.set_to(y);
                            actor.get_transition('scale-x')?.set_to(scale);
                            actor.get_transition('scale-y')?.set_to(scale);
                        };
                        self._snapBackRetarget = {
                            parent,
                            id: parent.connect('notify::allocation', retarget),
                        };
                    };

                    const restoreId = draggable.connect('drag-end', () => {
                        // The tween ended, or the clone was destroyed under it
                        // and dnd ended the drag without one.
                        self._stopSnapBackRetarget();
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
                this._blockWorkspaceCollection();
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
                        self._syncFloatingChrome(w);

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
                        lm._spatialDetached = [];
                        this._pinSpreadSlots(lm, lm._windowSlots);
                        for (const preview of container.get_children())
                            this._trackFloatingGeometry(lm, preview);

                        lm._getWindowSlots = function (containerBox) {
                            if (!self._spatialLayoutActive() ||
                                !this._spatialRefSlots)
                                return this._origGetWindowSlots.call(this, containerBox);
                            // Nothing to pin or morph towards: the strategy
                            // is already drawing the desktop, and it scales
                            // into whatever box it is handed rather than
                            // re-packing, so the shrunken fit-all box gives
                            // the same picture smaller. Ask it every pass so
                            // a retile lands here.
                            if (self._strategyOwnsGeometry(this)) {
                                return self._dropDetachedSlots(this,
                                    this._origGetWindowSlots.call(
                                        this, containerBox));
                            }
                            // The pin describes one layout, and a window
                            // arriving or leaving rebuilds it
                            // (workspace.js:672). Re-pin against the box the
                            // engage froze, not against the one being asked
                            // for: mid-zoom that box is a fraction of a
                            // workspace, and _adjustSpacingAndPadding reads
                            // the container's live transform to clamp it
                            // (workspace.js:497-510). A copy, because that
                            // clamp writes to the box it is handed.
                            //
                            // What the re-solve feeds is the spread end of the
                            // morph, which fitMode weighs at zero once the
                            // zoom has settled - where windows come and go.
                            if (this._layout !== this._spatialRefLayout) {
                                this._spatialRefLayout = this._layout;
                                this._spatialDetached = [];
                                self._pinSpreadSlots(this,
                                    this._origGetWindowSlots.call(
                                        this, this._spatialRefBox.copy()));
                                // The re-solve names every registered window,
                                // the dragged one included - dnd only
                                // reparents the actor, removeWindow is what
                                // unregisters it (workspace.js:840-870).
                                // Hand its slot back out before the allocate
                                // this answer feeds can reach it in
                                // Main.uiGroup.
                                self._detachDraggedSlots(this,
                                    this._container);
                                logTime('_getWindowSlots: re-pinned', {
                                    n: this._spatialRefSlots.length,
                                    fit: self._floatingFitMode().toFixed(2),
                                });
                            }
                            this._windowSlotsBox = this._spatialRefBox;
                            self._floatWindowSlots(this);
                            return this._spatialRefSlots;
                        };
                    }

                    // Every engage, not only the one that installs the pin: a
                    // pin already in place would keep the clone's slot.
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
        // Ahead of the guard, and on every pass: 'window-drag-cancelled' is
        // emitted at the top of _cancelDrag (dnd.js:592), with the clone still
        // in Main.uiGroup, so the hand-back has nothing to find that first
        // time. The pass that does is the 'window-drag-end' behind it, emitted
        // once _onAnimationComplete has made the clone a container child again
        // (dnd.js:518-535) - and by then this ran once already, so it arrives
        // with _dragActive cleared. The monitor's own reattach covers the same
        // moment, but only for a drag that got as far as patching the
        // draggable; this one every drag end reaches.
        this._reattachDetachedSlots();

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

        // Fit-all lasts as long as the drag, cancelled ones included.
        if (this._spatialLayoutActive()) {
            logTime('_onDragEnd: leaving fit-all', {isCancel});
            this._leaveFitAll();
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

    _leaveFitAll({animate = true, onDone = null, scrollTo = -1,
        duration = ZOOM_IN_DURATION} = {}) {
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
        // The pinned array, not _windowSlots: the two are the same reference
        // after the engage pins them (workspace.js:679), but a re-pin hands
        // _spatialRefSlots a fresh array while _windowSlots still holds the
        // old one until the allocate below returns (workspace.js:677).
        if (!lm._spatialRefSlots)
            return;
        const children = new Set(container.get_children());
        for (let i = lm._spatialRefSlots.length - 1; i >= 0; i--) {
            if (children.has(lm._spatialRefSlots[i][4]))
                continue;
            lm._spatialDetached.push([i, lm._spatialRefSlots[i]]);
            lm._spatialRefSlots.splice(i, 1);
        }
    }

    // The same rule as _detachDraggedSlots, for the path that re-solves. The
    // pin holds one array for the whole drag, so dropping the dragged slot
    // from it once, at the engage, holds; a strategy asked afresh every pass
    // hands the slot back every pass, and the clone flashes at whatever the
    // box means inside Main.uiGroup - the top of the screen - until the next
    // motion event puts it back under the pointer.
    _dropDetachedSlots(lm, slots) {
        const container = lm._container;
        if (!container)
            return slots;
        const children = new Set(container.get_children());
        return slots.filter(slot => children.has(slot[4]));
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
                // Asked of the container, not of the actor: a cross-workspace
                // drop destroys the preview, and get_parent() on the disposed
                // wrapper is a Gjs-CRITICAL. Set membership never reaches C.
                const children = new Set(container.get_children());
                // Pin dropped: upstream is solving for the live box again and
                // _windowSlots is its array, not ours to splice into. But if
                // the pin went while the preview was still in Main.uiGroup,
                // that array is the pinned one, solved without it, and
                // vfunc_allocate keeps it until _needsLayout
                // (workspace.js:669-680). Ask for the re-solve once the
                // preview is back.
                if (!lm._spatialRefSlots) {
                    const pending = lm._spatialDetached.filter(
                        ([, slot]) => !children.has(slot[4]));
                    if (pending.length === lm._spatialDetached.length)
                        continue;
                    lm._spatialDetached = pending;
                    lm._needsLayout = true;
                    container.queue_relayout();
                    continue;
                }
                let reattached = false;
                lm._spatialDetached = lm._spatialDetached.filter(([i, slot]) => {
                    if (!children.has(slot[4]))
                        return true;
                    lm._spatialRefSlots.splice(
                        Math.min(i, lm._spatialRefSlots.length), 0, slot);
                    reattached = true;
                    return false;
                });
                if (!reattached)
                    continue;
                // The slot came back with the values it was detached with -
                // the spread's. vfunc_allocate only re-resolves _windowSlots
                // when _needsLayout or the container box changed
                // (workspace.js:669-680), so a relayout alone would leave the
                // returned preview out of them - allocated, still on, and
                // drawing nowhere until a scroll changed the box. Mark
                // _needsLayout the way addWindow/removeWindow do
                // (workspace.js:823, 857), then let the relayout deliver it.
                //
                // Morph the slot here first, and hand the chrome back by the
                // same pass the other previews get theirs from - the returning
                // one shows what the drag left behind (windowPreview.js:661-668).
                //
                // Not while the zoom runs: the box changes every frame, which
                // re-reads the slots anyway, and a _needsLayout pass counts as
                // layoutChanged, which eases every preview in the workspace
                // over 200ms from where it stood (workspace.js:671-675,
                // 758-759, 389-399) - the ones that never left lag the zoom.
                this._floatWindowSlots(lm);
                this._syncFloatingChrome(w);
                lm.layout_frozen = false;
                if (!this._getWsDisplay()?._fitModeAdjustment
                    ?.get_transition('value'))
                    lm._needsLayout = true;
                view.queue_relayout();
                container.queue_relayout();
            }
        }
    }

    // FIXME downstream: at stateAdjustment 0 WorkspaceLayout already draws the
    // picture this asks for - every window where it really is, at
    // (boundingBox - workarea) * allocationScale (workspace.js:704-735), which
    // is what the app grid shows. Two things keep FitMode.ALL from simply
    // asking for it. _updateWorkspacesState drives that adjustment from
    // workspaceMode, which is why the hook above pins it at 1; and
    // vfunc_allocate clamps the floating box up to the slot size for as long
    // as currentState <= WINDOW_PICKER (workspace.js:723-729), which holds for
    // this whole zoom - it never leaves the window picker. Under that clamp a
    // window smaller than the slot the spread handed it is drawn at the slot's
    // size, hanging off the shrunken workspace.
    //
    // So the floating layout goes into the slots, where the clamp cannot reach
    // it: upstream's own mapping, into the box the pin froze. fitMode carries
    // the morph, so the zoom starts on the spread and lands on the desktop
    // with upstream drawing every frame in between.
    //
    // Ideal upstream fix: let a WorkspacesView in FitMode.ALL ask for the
    // floating layout, and clamp against the session only when the session is
    // where the transition is going.
    // Keyed by actor, not by index: _detachDraggedSlots splices the pinned
    // array, and _floatWindowSlots writes the morph into the entries it holds.
    _pinSpreadSlots(lm, slots) {
        lm._spatialRefSlots = slots;
        lm._spatialSpreadSlots = new Map(slots.map(
            ([x, y, width, height, child]) => [child, [x, y, width, height]]));
    }

    // FIXME downstream: a window leaving the workspace it was the last one on
    // empties that workspace, and _checkWorkspaces collects an empty workspace
    // as soon as the later after the drop runs (windowManager.js:283-289).
    // Every workspace past it slides down one, so a window dropped on the
    // third workspace is on the second by the time the drop animation ends -
    // the row reindexes under a gesture that is still going.
    //
    // The tracker already knows how to hold still: blockUpdates is what the
    // workspace switcher popup takes while it is on screen
    // (windowManager.js:1808-1817). Fit-all is the same kind of moment, only
    // longer - the whole row is on screen and being dragged across.
    // Collection resumes on the way out, which is where upstream would have
    // done it anyway.
    //
    // Ideal upstream fix: block updates for the duration of any overview drag,
    // not only for the switcher popup.
    _blockWorkspaceCollection() {
        const tracker = Main.wm?._workspaceTracker;
        if (!tracker || this._workspaceCollectionBlocked)
            return;

        tracker.blockUpdates();
        this._workspaceCollectionBlocked = true;
    }

    _unblockWorkspaceCollection() {
        if (!this._workspaceCollectionBlocked)
            return;

        this._workspaceCollectionBlocked = false;
        // The check the block deferred is still queued: _queueCheckWorkspaces
        // returns SOURCE_CONTINUE while paused (windowManager.js:231-233), so
        // it runs itself once this clears.
        Main.wm?._workspaceTracker?.unblockUpdates();
    }

    // Owned by the layout manager, so a preview that is destroyed or a
    // workspace that goes away takes the handler with it, and
    // _restoreWorkspacesState can hand back a whole workspace at once.
    //
    // Called from _floatWindowSlots as well as from the engage, because the
    // slot array is the only place that is guaranteed to name the previews
    // being drawn: a workspace rebuilt mid-drag brings previews that were
    // never handed to either the engage or addWindow, and a preview whose
    // geometry nothing re-reads is one that keeps drawing where it used to
    // be.
    _trackFloatingGeometry(lm, preview) {
        if (preview._spatialTrackedBy === lm)
            return;
        preview._spatialTrackedBy = lm;

        const refloat = () => {
            if (!lm._spatialRefSlots)
                return;
            // A strategy that answers from its own model re-reads nothing
            // from here; it announces its own changes (workspace.js:671-680,
            // via mosaicwm/mosaicRenderer.js:48-49) and the slot pass follows.
            if (this._strategyOwnsGeometry(lm))
                return;
            // The window set has not changed, only where one of them is, so
            // the spread reference still stands and only the floating end
            // needs re-reading.
            this._floatWindowSlots(lm);
            lm._container?.queue_relayout();
        };

        // The cache the floating layout reads is filled from this one
        // property (windowPreview.js:79-98), so this is the signal that says
        // "the number you are drawing from just changed". WindowPreview's own
        // size-changed is a filtered relay of it - it drops the notification
        // whenever the box is empty (windowPreview.js:96-97), which is
        // precisely the state a window being dragged passes through.
        preview.windowContainer?.layout_manager?.connectObject(
            'notify::bounding-box', refloat, lm);
        // Mutter's own pair, for the case where the actor's box has not
        // caught up yet: upstream only takes size-changed (workspace.js:801),
        // and a window that is moved without being resized never reaches it.
        preview.metaWindow?.connectObject(
            'position-changed', refloat,
            'size-changed', refloat,
            lm);
    }

    // Read while engaged, an unanswerable question is FitMode.ALL and not
    // FitMode.SINGLE: SINGLE is a real answer here - _floatWindowSlots reads
    // it as "draw the spread" - so falling back to it turns a lookup that
    // came up empty into a workspace that silently reverts, which is what a
    // drop used to do until the next relayout.
    _floatingFitMode() {
        if (!this._spatialLayoutActive())
            return FitMode.SINGLE;

        const adj = this._getWsDisplay()?._fitModeAdjustment;
        if (!adj) {
            logTime('_floatingFitMode: engaged with no adjustment');
            return FitMode.ALL;
        }
        return adj.value;
    }

    // Whether someone other than the shell answers for where a window goes.
    //
    // The shell's own strategy re-packs windows into rows and ignores where
    // they really are (workspace.js:145), so fit-all has to build the desktop
    // picture itself. A strategy installed by another extension already
    // answers in desktop geometry - and answers from its own model rather
    // than from the window, which is the only source that is current here:
    // with the overview up, Mutter drops the moves a tiling extension makes,
    // so it holds them until the overview hides and the real windows stay
    // where they were (mosaicwm/mosaicModel.js:32, mosaicwm/extension.js:533).
    // Floating over that draws a desktop that has not existed for a while.
    //
    // By class name because UnalignedLayoutStrategy is not exported.
    _strategyOwnsGeometry(lm) {
        const name = lm._layoutStrategy?.constructor?.name;
        return !!name && name !== 'UnalignedLayoutStrategy';
    }

    // Which box says where the window is: upstream's own answer for its
    // floating branch, WindowPreview.boundingBox (workspace.js:707-711) - the
    // union of the actors the preview draws, so it covers shadows and
    // attached dialogs, which the frame rect does not.
    //
    // It also covers the case the frame rect gets wrong. A window shrunk by
    // an extension that scales the actor keeps its full-size frame - measured
    // in the nested shell against a tiling extension's own log, a window it
    // had scaled to 256x205 at (586,314) still answered get_frame_rect with
    // 642x515 at (577,158), and that is the frame it will still answer with
    // after the scale is undone. The bounding box follows what is drawn.
    _floatWindowSlots(lm) {
        const workarea = lm._workarea;
        const spread = lm._spatialSpreadSlots;
        if (!workarea?.width || !spread)
            return;

        const fitMode = this._floatingFitMode();
        const scale = lm._spatialRefBox.get_width() / workarea.width;

        for (const slot of lm._spatialRefSlots) {
            this._trackFloatingGeometry(lm, slot[4]);

            const from = spread.get(slot[4]);
            const {x, y, width, height} = slot[4].boundingBox ?? {};
            // A window with nothing to show yet has no box to fly to.
            if (!from || !(width > 0))
                continue;

            const to = [
                (x - workarea.x) * scale, (y - workarea.y) * scale,
                width * scale, height * scale,
            ];
            for (let i = 0; i < 4; i++)
                slot[i] = from[i] + (to[i] - from[i]) * fitMode;
        }
    }

    // The app icon and the hover overlay are drawn for the spread and outlive
    // it: the icon's scale follows the overview state, which stays on
    // WINDOW_PICKER for the whole zoom (windowPreview.js:238-251), and
    // _syncOverlay keys off the state adjustment the hook pins at 1
    // (workspace.js:775-777). Both would sit over a layout that has no room
    // for them - the icons the issue calls distracting, on windows small
    // enough that the overlay covers what it labels.
    _syncFloatingChrome(workspace) {
        const lm = workspace._container?.layout_manager;

        // The registry, not the container's children: dnd reparents the
        // dragged preview into Main.uiGroup for the whole gesture
        // (dnd.js:220-227), so the child list stops naming the one preview
        // whose chrome the zoom still has to fade - the window being
        // carried. _windows keeps naming it until removeWindow runs
        // (workspace.js:840-870), and it is the set syncOverlays already
        // walks (workspace.js:783).
        //
        // Both are patched to read the zoom, so asking upstream's own
        // question again is what carries the fade - and what hands the answer
        // back whole once the zoom is over.
        const fitMode = this._floatingFitMode();
        for (const preview of lm?._windows?.keys() ?? []) {
            preview._updateIconScale?.();

            // FIXME downstream: hideOverlay clears _overlayShown before the
            // fade that takes the caption and the close button off, and its
            // own guard reads that flag (windowPreview.js:359-381). A fade
            // that never finishes therefore leaves both on screen with the
            // flag already saying they are down, and no later call reaches
            // them - measured with fit-all up: both actors visible,
            // _overlayShown false. Refusing the overlay is not enough; the
            // two actors have to be answered for, the way the icon is.
            if (fitMode > FitMode.SINGLE) {
                preview._title?.hide();
                preview._closeButton?.hide();
            }
        }
        lm?.syncOverlays();
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

    _stopSnapBackRetarget() {
        const retarget = this._snapBackRetarget;
        if (!retarget)
            return;

        this._snapBackRetarget = null;
        retarget.parent.disconnect(retarget.id);
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
        this._unblockWorkspaceCollection();
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
                // The hook stops running the moment _spatialLayoutActive turns
                // false, which can be a frame before the zoom-in ends, so the
                // icons and overlays are handed back from here rather than
                // from its last pass.
                this._syncFloatingChrome(w);
                for (const preview of container?.get_children() ?? []) {
                    preview._spatialTrackedBy = null;
                    preview.windowContainer?.layout_manager
                        ?.disconnectObject(lm);
                    preview.metaWindow?.disconnectObject(lm);
                }
                if (lm && lm._origGetWindowSlots !== undefined) {
                    lm._getWindowSlots = lm._origGetWindowSlots;
                    lm._origGetWindowSlots = undefined;
                    lm._spatialRefBox = undefined;
                    lm._spatialRefSlots = undefined;
                    lm._spatialRefLayout = undefined;
                    lm._spatialSpreadSlots = undefined;
                    // Not the entries still waiting on their preview:
                    // _reattachDetachedSlots needs them for the re-solve.
                    if (!lm._spatialDetached?.length)
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
        // WorkspaceIndicators builds its first dots straight in the
        // constructor, without scaleIn (panel.js:149-150), so nothing else
        // ever hands them a margin.
        const syncAllMargins = () => box.get_children().forEach(syncMargin);

        // FIXME downstream: a dot the shell eased while these handlers were
        // absent stays wherever the ease stopped. Upstream's scaleIn
        // (panel.js:107-119) has no onStopped, so an ease a reparent cuts
        // holds the scale it reached; upstream's scaleOutAndDestroy
        // (panel.js:121-131) destroys from onComplete, which a cut ease never
        // reaches. The dot stays a child either way and nothing moves it
        // again.
        //
        // Measured on the running session: a dot sat at scale_x 0 with no
        // transition and _destroying false - invisible, still holding its 8px
        // slot - and its margins were 0, the value syncMargin computes from
        // scale 0, so it was already stranded when this adopted the row. The
        // window is any stretch with the shell alive and these handlers off:
        // metadata.json declares no session-modes, so extensionSystem.js:393
        // defaults us to ['user'] and the lock screen disables us mid-ease.
        //
        // Ideal upstream fix: onStopped instead of onComplete in both, so a
        // cut ease settles where its own handler decides.
        for (const dot of box.get_children()) {
            if (dot.get_transition('scale-x'))
                continue;
            if (dot._destroying)
                dot.destroy();
            else if (dot.scale_x !== 1)
                dot.set({scale_x: 1, scale_y: 1});
        }
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

        // FIXME downstream: a reparent drops the actor's in-flight
        // transitions. Measured in the nested shell, remove_child +
        // insert_child_at_index 60ms into a 500ms ease: get_transition
        // ('scale-x') is null in the same turn, 'stopped' arrives with
        // finished false, and the scale holds the value it was cut at for the
        // rest of the session.
        //
        // _addToPanelBox reparents the Activities container on every
        // sessionMode change (panel.js:693-700), _reapplyPanelLayout again
        // after it. Measured across one such reparent, upstream's scaleIn
        // (panel.js:107-131) left a dot at scale 0.27 and 8px wide, and its
        // scaleOutAndDestroy never reached onComplete: the dot stayed a child
        // with _destroying set, which _getActiveIndicators skips and
        // _updateExpansion still counts by index.
        //
        // Ideal upstream fix: these two handlers.
        proto.scaleIn = function () {
            this.set({scale_x: 0, scale_y: 0});
            const id = trackWidth(this);
            syncWidth(this);
            this.ease({
                duration: WORKSPACE_DOT_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                scale_x: 1.0,
                scale_y: 1.0,
                // scaleOutAndDestroy sets _destroying before it eases, so the
                // ease it cuts here is not undone.
                onStopped: finished => {
                    this.disconnect(id);
                    if (!finished && !this._destroying)
                        this.set({scale_x: 1, scale_y: 1});
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
                // onStopped, not upstream's onComplete: _getActiveIndicators
                // hands out only dots without _destroying, so nothing else
                // eases this one.
                onStopped: () => this.destroy(),
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

    // The multiplier itself, unlike the width the dot derives from it, is
    // reachable from an extension: _updateExpansion is a plain prototype
    // method (panel.js:178-195), not a vfunc frozen into the vtable at
    // registerClass time like vfunc_get_preferred_width above.
    _patchWorkspaceDotWidth() {
        const box = this._getWorkspaceIndicators();
        if (!box)
            return;

        const proto = Object.getPrototypeOf(box);
        if (proto._spatialOrigUpdateExpansion)
            return;

        proto._spatialOrigUpdateExpansion = proto._updateExpansion;
        // Upstream's body (panel.js:178-195) apart from the multiplier.
        proto._updateExpansion = function () {
            const nIndicators = this._getActiveIndicators().length;
            const activeWorkspace = this._workspacesAdjustment.value;

            const extraDots =
                Math.max(nIndicators - WORKSPACE_DOT_WIDTH_PLATEAU, 0);
            const widthMultiplier = Math.max(
                WORKSPACE_DOT_WIDTH_MAX - WORKSPACE_DOT_WIDTH_STEP * extraDots,
                WORKSPACE_DOT_WIDTH_MIN);

            this.get_children().forEach((indicator, index) => {
                const distance = Math.abs(index - activeWorkspace);
                indicator.expansion = Math.clamp(1 - distance, 0, 1);
                indicator.widthMultiplier = widthMultiplier;
            });
        };

        this._workspaceIndicatorsProto = proto;
        // Nothing re-runs _updateExpansion until the adjustment moves: the box
        // connects it to notify::value and notify::upper only
        // (panel.js:143-147).
        box._updateExpansion();
        logTime('_patchWorkspaceDotWidth: pill width ramps with dot count');
    }

    _restoreWorkspaceDotWidth() {
        const proto = this._workspaceIndicatorsProto;
        if (!proto)
            return;

        proto._updateExpansion = proto._spatialOrigUpdateExpansion;
        delete proto._spatialOrigUpdateExpansion;
        this._workspaceIndicatorsProto = null;
        this._getWorkspaceIndicators()?._updateExpansion();
        logTime('_restoreWorkspaceDotWidth');
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

    // ActivitiesButton keeps a 'checked' pseudo class for as long as the
    // overview is up (panel.js:211-219), which the theme paints as a filled
    // pill behind the dots. Upstream that pill sits in the panel's left
    // corner; _patchPanelLayout centers it, directly above the overview's
    // search entry - two stacked pills of the same shape (issue #2).
    //
    // 'active' on a panel button means its menu is open (panelMenu.js:
    // 168-172) and this button is built without one (panel.js:200), so
    // dropping 'checked' leaves the theme painting hover and focus only -
    // the feedback the issue asks to keep.
    _patchActivitiesChecked() {
        const activities = Main.panel?.statusArea?.activities;
        if (!activities || this._activitiesCheckedPatched)
            return;

        // connectObject tracks both handlers under the button, and those two
        // are the only ones ActivitiesButton registers on Main.overview, so
        // disconnecting by owner takes exactly them.
        Main.overview.disconnectObject(activities);
        activities.remove_style_pseudo_class('checked');

        this._activitiesCheckedPatched = true;
        logTime('_patchActivitiesChecked: overview no longer checks the button');
    }

    _restoreActivitiesChecked() {
        if (!this._activitiesCheckedPatched)
            return;
        this._activitiesCheckedPatched = false;

        const activities = Main.panel?.statusArea?.activities;
        if (!activities)
            return;

        Main.overview.connectObject('showing',
            () => activities.add_style_pseudo_class('checked'),
            activities);
        Main.overview.connectObject('hiding',
            () => activities.remove_style_pseudo_class('checked'),
            activities);
        // The handlers only fire on a transition, and the overview can already
        // be up when this runs.
        if (Main.overview.visible)
            activities.add_style_pseudo_class('checked');

        logTime('_restoreActivitiesChecked');
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
