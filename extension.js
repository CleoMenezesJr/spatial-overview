import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import {FitMode, WorkspacesView} from 'resource:///org/gnome/shell/ui/workspacesView.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

const TAG = '[SPATIAL-WS]';
const DEBUG = GLib.getenv('SPATIAL_WS_DEBUG') !== null;
const logTime = DEBUG
    ? (...a) => console.log(TAG, `t=${Date.now() % 100000}`, ...a)
    : () => {};
const ZOOM_OUT_DURATION = 210;
const ZOOM_IN_DURATION = 400;
const ZOOM_OUT_HOLD_DELAY = 150;
const BACKDROP_OPACITY = 180;
const MIN_WS_SCALE = 0.18;
const WORKSPACE_CUT_SIZE = 10; // workspaceThumbnail.js:27
const PLACEHOLDER_WIDTH = 24;

// Replicates _getRealActorScale from dnd.js (not exported upstream).
// Walks up the actor tree multiplying scale_x - needed to compute
// the FitMode.SINGLE stage position of the clone's parent (workspace
// thumbnail) before our zoom-out has changed it.
function _getRealActorScale(actor) {
    let scale = 1.0;
    let current = actor;
    while (current) {
        scale *= current.scale_x;
        current = current.get_parent();
    }
    return scale;
}

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
        this._progressSignalId = null;
        this._fitModeNotifyId = 0;
        this._fitModeNotifyAdj = null;
        this._restoreIdleId = 0;
        this._engageTimeoutId = 0;
        this._spatialEngaged = false;
        this._dropInsertIndex = -1;
        this._dropWorkspaceIndex = -1;
        this._sessionModeUpdatedId = 0;
        this._panelPatched = false;

        this._patchPanelLayout();
        this._patchDraggableCaptureOrigin();
        this._patchFitAllLayout();

        this._zoomOutView = new ZoomOutView();
        this._zoomOutView._extension = this;
        Main.layoutManager.overviewGroup.add_child(this._zoomOutView);

        this._overrideThumbnailsShouldShow();

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
    }

    // FIXME downstream: _getRestoreLocation (dnd.js:453) reads the drag origin
    // parent's transformed position at drop time (dnd.js:465-466), when our
    // zoom-out has already moved it to FitMode.ALL. Capture the FitMode.SINGLE
    // transform at gesture recognition instead.
    // Ideal upstream fix: snapshot the restore location in _gestureRecognized,
    // where _dragOrigParent/_dragOrigX/Y/Scale are already recorded, or take it
    // as a makeDraggable() param. Same for _getRealActorScale (dnd.js:54),
    // private upstream and replicated above.
    //
    // _Draggable isn't exported, so reach its prototype via a throwaway
    // draggable. Patching once here beats hooking a clone constructor, which
    // re-wraps the prototype per instance and can't be undone.
    _patchDraggableCaptureOrigin() {
        if (this._draggablePatched)
            return;

        const dummy = new Clutter.Actor();
        const dragProto = Object.getPrototypeOf(DND.makeDraggable(dummy));
        dummy.destroy();

        if (!dragProto?._gestureRecognized) {
            logTime('_Draggable prototype not found!');
            return;
        }

        // maps metaWindow -> FitMode.SINGLE parent pos+scale for snap-back
        this._fitSingleByMetaWindow = new Map();

        const ext = this;
        const origGestureRecognized = dragProto._gestureRecognized;
        this._dragProto = dragProto;
        this._origGestureRecognized = origGestureRecognized;

        dragProto._gestureRecognized = function () {
            const result = origGestureRecognized.call(this);
            // _dragOrigParent is set inside _gestureRecognized (dnd.js:199) and
            // still holds the FitMode.SINGLE transform: our ease was only queued.
            // dnd.js nulls it on destroy, so get_stage() is all we need to know
            // the transform is meaningful.
            const parent = this._dragOrigParent;
            if (parent?.get_stage()) {
                const mw = this.actor?._delegate?.metaWindow
                    ?? this.actor?.meta_window
                    ?? this.actor?.metaWindow;
                if (mw) {
                    const [px, py] = parent.get_transformed_position();
                    const ps = _getRealActorScale(parent);
                    if (Number.isFinite(px) && Number.isFinite(py)) {
                        ext._fitSingleByMetaWindow.set(mw, {px, py, scale: ps});
                        // Not every recognized gesture reaches our drag
                        // monitor, so the entry can't be dropped where it's
                        // read.
                        const id = this.connect('drag-end', () => {
                            ext._fitSingleByMetaWindow?.delete(mw);
                            this.disconnect(id);
                        });
                    }
                }
            }
            return result;
        };

        this._draggablePatched = true;
    }

    _restoreDraggableCaptureOrigin() {
        if (!this._draggablePatched)
            return;
        if (this._dragProto && this._origGestureRecognized)
            this._dragProto._gestureRecognized = this._origGestureRecognized;
        this._origGestureRecognized = null;
        this._dragProto = null;
        this._draggablePatched = false;
        this._fitSingleByMetaWindow?.clear();
        this._fitSingleByMetaWindow = null;
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
        // Returns {scale, wsSize, adjSpacing} where wsSize is the workspace
        // width (horizontal) or height (vertical).
        const _computeFitAll = (avail, n, portholeSize, spacing) => {
            // idealScale: what upstream would compute (fill-all-minus-spacing)
            const idealScale = (avail - spacing * (n + 1)) / n / portholeSize;

            // With proportional scaling, we want workspaces to shrink
            // gracefully. Use SPRING_FACTOR to transition from idealScale
            // toward MIN_WS_SCALE as n grows, but never exceed idealScale
            // (so few-workspaces layout is preserved) and never go below
            // MIN_WS_SCALE unless even spacing=0 can't fit them.
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

            let wsSize = Math.round(portholeSize * scale);

            // Hard floor: if wsSize * n > avail even with spacing=0,
            // MUST shrink below MIN_WS_SCALE to fit.
            if (wsSize * n > avail) {
                scale = avail / n / portholeSize;
                wsSize = Math.round(portholeSize * scale);
            }

            // Recalculate spacing to absorb leftover space (centered).
            let adjSpacing;
            if (n > 1) {
                const leftover = avail - wsSize * n;
                adjSpacing = Math.max(leftover / (n + 1), 0);
            } else {
                adjSpacing = spacing;
            }

            return {scale, wsSize, adjSpacing};
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

            if (vertical) {
                const {wsSize: wsH, adjSpacing} = _computeFitAll(
                    height, nWorkspaces, portholeH, spacing);
                const [, wsW] = workspace.get_preferred_width(wsH);
                y1 = adjSpacing;
                if (wsW > width) {
                    const [, realH] = workspace.get_preferred_height(width);
                    y1 += Math.max(
                        (height - adjSpacing * 2 - realH * nWorkspaces) / 2, 0);
                }
                fitAllBox.set_size(width, wsH);
            } else {
                const {wsSize: wsW, adjSpacing} = _computeFitAll(
                    width, nWorkspaces, portholeW, spacing);
                const [, wsH] = workspace.get_preferred_height(wsW);
                x1 = adjSpacing;
                if (wsH > height) {
                    const [, realW] = workspace.get_preferred_width(height);
                    x1 += Math.max(
                        (width - adjSpacing * 2 - realW * nWorkspaces) / 2, 0);
                }
                fitAllBox.set_size(wsW, height);
            }

            fitAllBox.set_origin(x1, y1);

            logTime('fitAllLayout', JSON.stringify({
                n: nWorkspaces,
                scale: (fitAllBox.get_size()[0] / portholeW).toFixed(3),
                wsW: fitAllBox.get_size()[0], spacing, portholeW,
            }));

            return fitAllBox;
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
        this._origGetFirstFitAllWorkspaceBox = null;
        this._origGetSpacing = null;
        this._fitAllPatched = false;
    }

    disable() {
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

        this._disconnectFitModeNotify();
        this._removeRestoreIdle();
        this._removeEngageTimeout();
        this._spatialEngaged = false;
        this._restoreWorkspacesState();
        this._restoreDraggableCaptureOrigin();
        this._restoreFitAllLayout();
        this._restorePanelLayout();
        this._dragActive = false;

        if (this._zoomOutView) {
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
                    // lookup here, not in _onDragBegin: patched _gestureRecognized
                    // populates the map synchronously AFTER origGR triggers
                    // drag-begin then window-drag-begin, so reading it in
                    // _onDragBegin always sees an empty map
                    self._fitSingleParent = self._fitSingleByMetaWindow?.get(this._draggedMetaWindow) ?? null;
                    // FIXME downstream: GNOME's _getRestoreLocation uses the
                    // parent's *current* transformed position at snap-back
                    // time. During our zoom-out (FitMode.ALL) the parent is
                    // repositioned, so the snap-back would target FitMode.ALL.
                    // We replace it with the clone's captured FitMode.SINGLE
                    // stage position (captured in patched Draggable._gestureRecognized).
                    const draggable = this._activeDraggable;
                    this._origGetRestoreLocation = draggable._getRestoreLocation;
                    draggable._getRestoreLocation = function () {
                        if (self._fitSingleParent) {
                            // _fitSingleParent has the FitMode.SINGLE parent stage pos+scale.
                            // _dragOrigX/Y are the clone's allocation within the parent (FitMode.SINGLE).
                            // Compute the clone's FitMode.SINGLE stage position.
                            const p = self._fitSingleParent;
                            return [
                                p.px + p.scale * this._dragOrigX,
                                p.py + p.scale * this._dragOrigY,
                                this._dragOrigScale * p.scale,
                            ];
                        }
                        return self._origGetRestoreLocation.call(this);
                    };
                    // FIXME downstream: the endpoint is only half of the
                    // snap-back. _cancelDrag eases for SNAP_BACK_ANIMATION_TIME
                    // (dnd.js:611), and when that ease stops
                    // _onAnimationComplete (dnd.js:518) reparents the clone into
                    // _dragOrigParent and clears its fixed position. From there
                    // WorkspaceLayout owns it, and it allocates previews rather
                    // than transforming a container (workspace.js:694-769) - so
                    // a snap-back ending before our zoom-in hands the clone to a
                    // parent still in motion, and it drops onto the slot the
                    // zoom-in has reached instead of the endpoint it was eased
                    // to.
                    //
                    // Both eases use EASE_OUT_CUBIC and are created in the same
                    // frame, so equal durations put the handoff on the value the
                    // ease already reached. Ideal upstream fix: let the drag
                    // origin own the snap-back - endpoint and clock - which is
                    // the same gap _getRestoreLocation above works around.
                    this._origAnimateDragEnd = draggable._animateDragEnd;
                    draggable._animateDragEnd = function (eventTime, params) {
                        // _spatialEngaged is already false when the drop landed
                        // inside ZOOM_OUT_HOLD_DELAY: _onDragEnd cleared it and
                        // there is no zoom-in to wait for. The duration test
                        // leaves the restoreOnSuccess path alone - it reaches
                        // here too, on REVERT_ANIMATION_TIME (dnd.js:489).
                        if (self._spatialEngaged &&
                            params.duration === DND.SNAP_BACK_ANIMATION_TIME) {
                            logTime('snap-back retimed', {
                                duration: ZOOM_IN_DURATION,
                            });
                            params = {...params, duration: ZOOM_IN_DURATION};
                        }
                        return self._origAnimateDragEnd.call(
                            this, eventTime, params);
                    };
                    const restoreId = draggable.connect('drag-end', () => {
                        self._reattachDetachedSlots();
                        draggable._getRestoreLocation =
                            self._origGetRestoreLocation;
                        draggable._animateDragEnd = self._origAnimateDragEnd;
                        self._origGetRestoreLocation = null;
                        self._origAnimateDragEnd = null;
                        self._fitSingleParent = null;
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
            for (const view of ws._workspacesViews ?? []) {
                if (!view._workspaces || view._origUpdateWorkspacesState)
                    continue;
                view._origUpdateWorkspacesState = view._updateWorkspacesState;
                const origFn = view._origUpdateWorkspacesState;
                view._updateWorkspacesState = function () {
                    origFn?.call(this);
                    if (self._spatialLayoutActive()) {
                        for (const w of this._workspaces ?? [])
                            w.stateAdjustment.value = 1;
                    }
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
                    if (w._origClip === undefined) {
                        w._origClip = w.clip_to_allocation;
                        w.clip_to_allocation = true;
                    }
                    const container = w._container;
                    if (container && container._origClip === undefined) {
                        container._origClip = container.clip_to_allocation;
                        container.clip_to_allocation = true;
                    }

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

                        // FIXME downstream: a preview being dragged keeps its
                        // slot - removeWindow (workspace.js:853) says as much,
                        // "the window might have been reparented by DND" - so
                        // vfunc_allocate keeps calling child.allocate() on an
                        // actor that now lives in Main.uiGroup. The slot box is
                        // container-local, so it lands somewhere else entirely,
                        // and the clone only snaps back under the pointer on
                        // the next motion event, when dnd re-asserts its fixed
                        // position. Upstream never sees this because nothing
                        // relayouts a workspace mid-drag; the zoom does it every
                        // frame. Ideal upstream fix: skip slots whose actor the
                        // container no longer parents.
                        lm._spatialDetached = [];
                        for (let i = lm._windowSlots.length - 1; i >= 0; i--) {
                            if (lm._windowSlots[i][4].get_parent() === container)
                                continue;
                            lm._spatialDetached.push([i, lm._windowSlots[i]]);
                            lm._windowSlots.splice(i, 1);
                        }

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
        // Not value alone: a drop landing within a frame of _engageSpatialLayout
        // finds the ease to FitMode.ALL queued but not yet advanced, so the
        // value still reads exactly SINGLE while a zoom-out is in flight.
        // Taking the no-op branch there left that ease running with nothing to
        // undo it, stranding the overview in fit-all.
        const fitAdj = ws?._fitModeAdjustment;
        const alreadyChanged = fitAdj?.value === FitMode.SINGLE &&
            !fitAdj?.get_transition('value');
        if (!alreadyChanged && fitAdj && this._spatialLayoutActive()) {
            logTime('_onDragEnd: starting zoom-in ease to FitMode.SINGLE', {isCancel});
            ws._fitModeAdjustment.remove_transition('value');
            ws._fitModeAdjustment.ease(FitMode.SINGLE, {
                duration: ZOOM_IN_DURATION,
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
                },
            });
        } else {
            logTime('_onDragEnd: no zoom-in', {
                isCancel, engaged: this._spatialEngaged,
            });
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
                lm._spatialDetached = lm._spatialDetached.filter(([i, slot]) => {
                    if (slot[4].get_parent() !== container)
                        return true;
                    lm._windowSlots.splice(
                        Math.min(i, lm._windowSlots.length), 0, slot);
                    return false;
                });
                container.queue_relayout();
            }
        }
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

    _restoreWorkspacesState() {
        this._reattachDetachedSlots();
        const ws = this._getWsDisplay();
        for (const view of ws?._workspacesViews ?? []) {
            if (view._origUpdateWorkspacesState) {
                view._updateWorkspacesState = view._origUpdateWorkspacesState;
                view._origUpdateWorkspacesState = null;
                view._updateWorkspacesState();
            }
            for (const w of view._workspaces ?? []) {
                if (w._origClip !== undefined) {
                    w.clip_to_allocation = w._origClip;
                    w._origClip = undefined;
                }
                const container = w._container;
                if (container && container._origClip !== undefined) {
                    container.clip_to_allocation = container._origClip;
                    container._origClip = undefined;
                }
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
        // DateMenuButton aligns at 0.5 (dateMenu.js:863). Each box holds one
        // child, so the swap is visually neutral.
        if (dateMenu?.container) {
            const parent = dateMenu.container.get_parent();
            if (parent)
                parent.remove_child(dateMenu.container);
            panel._leftBox.insert_child_at_index(dateMenu.container, 0);
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
            const parent = dateMenu.container.get_parent();
            if (parent)
                parent.remove_child(dateMenu.container);
            panel?._centerBox?.insert_child_at_index(dateMenu.container, 0);
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
