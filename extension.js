import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';
import {WorkspacesView} from 'resource:///org/gnome/shell/ui/workspacesView.js';

const TAG = '[SPATIAL-WS]';
const logTime = (...a) => console.log(TAG, `t=${(Date.now() % 100000)}`, ...a);
const ZOOM_OUT_DURATION = 250;
const ZOOM_IN_DURATION = 250;
const BACKDROP_OPACITY = 180;
const FIT_ALL = 1;
const FIT_SINGLE = 0;
const MIN_WS_SCALE = 0.18;

function uiGroupChildCount() {
    try {
        const ug = Main.uiGroup;
        if (!ug) return -1;
        const kids = ug.get_children?.();
        if (Array.isArray(kids)) return kids.length;
        if (typeof ug.get_n_children === 'function') return ug.get_n_children();
        return -1;
    } catch {
        return -1;
    }
}

function dropInUiGroup(actor) {
    if (!actor) return false;
    try {
        return actor.get_parent?.() === Main.uiGroup;
    } catch {
        return false;
    }
}

// Replicates _getRealActorScale from dnd.js (not exported upstream).
// Walks up the actor tree multiplying scale_x — needed to compute
// the FIT_SINGLE stage position of the clone's parent (workspace
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
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    hide() {
        logTime('VIEW.hide start (zoom-in)');
        this._progressAdj.ease(0, {
            duration: ZOOM_IN_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
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
        const isWindow = !!source?.metaWindow;
        const insertIndex =
            this._extension._getInsertWorkspaceIndex(x, y);
        if (insertIndex >= 0) {
            const rect =
                this._extension._getInsertRect(insertIndex);
            if (rect) {
                this.setDropPlaceholderRect(rect);
                logTime('VIEW.handleDragOver => INSERT',
                    {insertIndex, x, y, rect});
                return isWindow
                    ? DND.DragMotionResult.MOVE_DROP
                    : DND.DragMotionResult.COPY_DROP;
            }
        }

        // No insert zone: clear placeholder, then try existing-workspace drop.
        this.setDropPlaceholderRect(null);
        const wsIndex = this._extension._getWorkspaceIndexAt(x, y);
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

export default class SpatialWorkspaceExtension extends Extension {
    enable() {
        this._dragActive = false;
        this._dragMonitor = null;
        this._draggedMetaWindow = null;
        this._dragBeginId = null;
        this._dragEndId = null;
        this._dragCancelledId = null;
        this._progressSignalId = null;

        this._patchWindowCloneRestoreOnSuccess();
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

    _patchWindowCloneRestoreOnSuccess() {
        if (this._windowClonePatched)
            return;
        const WindowClone = WorkspaceThumbnail.WindowClone;
        const proto = WindowClone?.prototype;
        if (!proto) {
            logTime('WindowClone prototype not found!');
            return;
        }
        const origInit = proto._init;
        this._origWindowCloneInit = origInit;
        const ext = this;

        // Maps for snap-back: metaWindow → FIT_SINGLE parent info
        this._fitSingleByMetaWindow = new Map();

        proto._init = function (realWindow) {
            const r = origInit.call(this, realWindow);
            try {
                if (!this._draggable)
                    return r;
                this._draggable._restoreOnSuccess = false;
                // Patch the Draggable's _gestureRecognized once per class to
                // capture the clone's parent's FIT_SINGLE transform. This is
                // the only reliable window: before zoom-out, while the clone
                // is still parented to the workspace view at FIT_SINGLE.
                const draggable = this._draggable;
                if (!draggable.__spatialWsPatched) {
                    draggable.__spatialWsPatched = true;
                    const dragProto = Object.getPrototypeOf(draggable);
                    ext._dragProto = dragProto;
                    const origGR = dragProto._gestureRecognized;
                    ext._origGestureRecognized = origGR;
                    dragProto._gestureRecognized = function () {
                        const r2 = origGR.call(this);
                        const parent = this._dragOrigParent;
                        if (parent && !parent.is_destroyed?.()) {
                            const mw = this.actor?._delegate?.metaWindow
                                ?? this.actor?.meta_window
                                ?? this.actor?.metaWindow;
                            if (mw) {
                                const [px, py] = parent.get_transformed_position();
                                const ps = _getRealActorScale(parent);
                                if (Number.isFinite(px) && Number.isFinite(py))
                                    ext._fitSingleByMetaWindow.set(mw, {px, py, scale: ps});
                            }
                        }
                        return r2;
                    };
                }
            } catch (e) {
                logTime('WindowClone patch error', e.message);
            }
            return r;
        };
        this._windowClonePatched = true;
    }

    _restoreWindowCloneInit() {
        if (!this._windowClonePatched) return;
        const WindowClone = WorkspaceThumbnail.WindowClone;
        const proto = WindowClone?.prototype;
        if (proto && this._origWindowCloneInit) {
            proto._init = this._origWindowCloneInit;
        }
        if (this._dragProto && this._origGestureRecognized) {
            this._dragProto._gestureRecognized = this._origGestureRecognized;
        }
        this._origWindowCloneInit = null;
        this._origGestureRecognized = null;
        this._dragProto = null;
        this._windowClonePatched = false;
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
            // Delegate to original for non-ALL modes.
            if (fitMode !== 1) // FitMode.ALL === 1
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

        this._restoreWorkspacesState();
        this._restoreWindowCloneInit();
        this._restoreFitAllLayout();
        this._dragActive = false;

        if (this._zoomOutView) {
            this._zoomOutView.destroy();
            this._zoomOutView = null;
        }
    }

    _onDragBegin(metaWindow) {
        logTime('_onDragBegin ENTER (zoom-out will start)');
        this._dragActive = true;
        const self = this;

        // Look up FIT_SINGLE parent position+scale captured by the patched
        // Draggable._gestureRecognized (before zoom-out, when transforms
        // are still valid). Used by _getRestoreLocation override.
        this._fitSingleParent = this._fitSingleByMetaWindow?.get(metaWindow) ?? null;

        this._draggedMetaWindow = null;
        this._lastCursorX = 0;
        this._lastCursorY = 0;
        this._dragMotionCount = 0;
        this._activeDraggable = null;

        this._dragMonitor = {
            dragMotion: (dragEvent) => {
                this._draggedMetaWindow = dragEvent.source?.metaWindow || this._draggedMetaWindow;
                if (!this._activeDraggable && dragEvent.source?._draggable) {
                    this._activeDraggable = dragEvent.source._draggable;
                    // FIXME downstream: GNOME's _getRestoreLocation uses the
                    // parent's *current* transformed position at snap-back
                    // time. During our zoom-out (FIT_ALL) the parent is
                    // repositioned, so the snap-back would target FIT_ALL.
                    // We replace it with the clone's captured FIT_SINGLE
                    // stage position (captured in patched Draggable._gestureRecognized).
                    const draggable = this._activeDraggable;
                    this._origGetRestoreLocation = draggable._getRestoreLocation;
                    draggable._getRestoreLocation = function () {
                        if (self._fitSingleParent) {
                            // _fitSingleParent has the FIT_SINGLE parent stage pos+scale.
                            // _dragOrigX/Y are the clone's allocation within the parent (FIT_SINGLE).
                            // Compute the clone's FIT_SINGLE stage position.
                            const p = self._fitSingleParent;
                            return [
                                p.px + p.scale * this._dragOrigX,
                                p.py + p.scale * this._dragOrigY,
                                this._dragOrigScale * p.scale,
                            ];
                        }
                        return self._origGetRestoreLocation.call(this);
                    };
                    const restoreId = draggable.connect('drag-end', () => {
                        draggable._getRestoreLocation =
                            self._origGetRestoreLocation;
                        self._origGetRestoreLocation = null;
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
                        dropActorInUiGroup: dropInUiGroup(dragEvent.dropActor),
                        uiGroupChildren: uiGroupChildCount(),
                    });
                return DND.DragMotionResult.CONTINUE;
            },
            // No dragDrop: skip monitor's drop callback entirely, let
            // dnd.js's _dragActorDropped walk its target chain. Our ZoomOutView
            // has acceptDrop which will handle the workspace change.
            dragDrop: undefined,
        };
        DND.addDragMonitor(this._dragMonitor);

        const controls = this._getControls();
        if (controls) {
            const ws = controls._workspacesDisplay;
            if (ws?._fitModeAdjustment && !self._isInAppGrid()) {
                ws._fitModeAdjustment.remove_transition('value');
                ws._fitModeAdjustment.ease(FIT_ALL, {
                    duration: ZOOM_OUT_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }

            // FIXME downstream: whenever upstream GNOME exposes this flag,
            // drop this monkey-patch. (Tracked for upstream contribution.)
            //
            // _updateWorkspacesState computes workspaceMode = (1 - fitMode) * lerp(...)
            // which is 0 in FIT_ALL — causing WindowPreviews to render in
            // desktop mode (overflowing the shrunken Workspace actor). We
            // force stateAdjustment.value = 1 so WindowPreviews rearrange
            // (overview layout) to fit the Workspace rect in FIT_ALL.
            for (const view of ws._workspacesViews ?? []) {
                if (!view._workspaces || view._origUpdateWorkspacesState)
                    continue;
                view._origUpdateWorkspacesState = view._updateWorkspacesState;
                const origFn = view._origUpdateWorkspacesState;
                view._updateWorkspacesState = function () {
                    origFn?.call(this);
                    if (!self._isInAppGrid()) {
                        for (const w of this._workspaces ?? [])
                            w.stateAdjustment.value = 1;
                    }
                };
                view._updateWorkspacesState();
            }

            // FIXME downstream: in GNOME 50.3 WorkspaceLayout.vfunc_allocate
            // computes window slots using the *container* box (the shrunken
            // Workspace actor in FIT_ALL), so a single maximized window fills
            // the entire shrunk rect (the WINDOW_PREVIEW_MAXIMUM_SCALE = 0.95
            // cap never kicks in because horizontalScale = containerW/bbW is
            // already < 0.95). Patch _getWindowSlots + _windowSlotsBox to use
            // the full workarea-sized box for layout, so slots are computed
            // at workarea scale and slotsScale (=containerW/workareaW)
            // properly shrinks them into the Workspace actor.
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
                        lm._origGetWindowSlots = lm._getWindowSlots;
                        lm._getWindowSlots = function (_containerBox) {
                            if (self._isInAppGrid()) {
                                return this._origGetWindowSlots.call(this, _containerBox);
                            }
                            if (!this._workarea || !this._layoutStrategy ||
                                !this._layout) {
                                const slots =
                                    this._origGetWindowSlots.call(this, _containerBox);
                                if (!this._windowSlotsBox && _containerBox)
                                    this._windowSlotsBox = _containerBox;
                                return slots;
                            }
                            // Bypass _adjustSpacingAndPadding which
                            // shrinks the box based on monitor/stage
                            // placements meaningless in FIT_ALL. Use the
                            // full workarea-sized box directly so the
                            // WINDOW_PREVIEW_MAXIMUM_SCALE = 0.95 cap
                            // kicks in and slots fill ~95% of workarea.
                            const workareaBox = new Clutter.ActorBox();
                            workareaBox.set_origin(0, 0);
                            workareaBox.set_size(this._workarea.width,
                                this._workarea.height);
                            const availArea = {
                                x: 0,
                                y: 0,
                                width: this._workarea.width,
                                height: this._workarea.height,
                            };
                            const slots =
                                this._layoutStrategy.computeWindowSlots(
                                    this._layout, availArea);
                            this._windowSlotsBox = workareaBox;
                            return slots;
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
            this._hideDropPlaceholder();
            return false;
        }

        // FIXME downstream: create-new-workspace-via-drop replica of
        // ThumbnailsBox.acceptDrop (workspaceThumbnail.js:877-920).
        // Upstream WorkspacesView has no drop-to-create path.
        if (this._zoomOutView?._dropPlaceholder?.visible) {
            const insertIndex = this._getInsertWorkspaceIndex(x, y);
            if (insertIndex >= 0) {
                logTime('_handleDrop: insert workspace at', insertIndex);
                this._createWorkspaceAt(insertIndex, metaWindow);
                this._hideDropPlaceholder();
                return true;
            }
        }

        const wsIndex = this._getWorkspaceIndexAt(x, y);
        if (wsIndex < 0) {
            logTime('_handleDrop: outside any workspace -> skip (no anim)');
            this._dropWasNoop = true;
            this._hideDropPlaceholder();
            return false;
        }
        const targetWs = global.workspace_manager.get_workspace_by_index(wsIndex);
        const currentWs = metaWindow.get_workspace();
        if (currentWs === targetWs) {
            logTime('_handleDrop: same workspace -> skip (no anim)');
            this._dropWasNoop = true;
            this._hideDropPlaceholder();
            return false;
        }
        logTime('_handleDrop: change_workspace CALLED', {
            from: currentWs?.index?.() ?? -1,
            to: wsIndex,
            title: metaWindow.get_title?.() ?? '?',
        });
        metaWindow.change_workspace(targetWs);
        this._hideDropPlaceholder();
        // Don't snap fitModeAdjustment here — _onDragEnd (triggered
        // synchronously by change_workspace -> window-drag-end signal)
        // owns the zoom-in ease. Snapping here would remove_transition
        // and set value=FIT_SINGLE mid-ease, skipping the animation.
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

    _hideDropPlaceholder() {
        if (this._zoomOutView)
            this._zoomOutView.setDropPlaceholderRect(null);
    }

    _onDragEnd(isCancel = false) {
        if (!this._dragActive) {
            logTime('_onDragEnd: not active (already ended?) -> skip');
            return;
        }
        this._dragActive = false;

        logTime('_onDragEnd START', {
            dragMotionTotal: this._dragMotionCount,
            isCancel,
            dropWasNoop: !!this._dropWasNoop,
        });
        const dropWasNoop = !!this._dropWasNoop;
        this._dropWasNoop = false;

        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._draggedMetaWindow = null;

        // FIXME downstream: always clear the insertion placeholder on drag
        // end/cancel, mirroring ThumbnailsBox._clearDragPlaceholder
        // (workspaceThumbnail.js:764-770).
        this._hideDropPlaceholder();

        const ws = this._getWsDisplay();
        const inAppGrid = this._isInAppGrid();
        const alreadyChanged = ws?._fitModeAdjustment?.value === FIT_SINGLE;
        if (!alreadyChanged && ws?._fitModeAdjustment && !inAppGrid) {
            logTime('_onDragEnd: starting zoom-in ease to FIT_SINGLE', {isCancel});
            ws._fitModeAdjustment.remove_transition('value');
            ws._fitModeAdjustment.ease(FIT_SINGLE, {
                duration: ZOOM_IN_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this._restoreWorkspacesState();
                        return GLib.SOURCE_REMOVE;
                    });
                },
            });
        } else {
            logTime('_onDragEnd: fitMode already FIT_SINGLE or inAppGrid, no zoom-in', {isCancel, inAppGrid});
            this._restoreWorkspacesState();
        }

        if (ws) {
            for (const view of ws._workspacesViews ?? []) {
                for (const w of view._workspaces ?? [])
                    w.reactive = true;
            }
        }

        if (this._zoomOutView)
            this._zoomOutView.hide();

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            logTime('POST-DRAG +800ms', {
                uiGroupChildren: uiGroupChildCount(),
                overviewVisible: Main.overview?.visible,
                overviewInWindowDrag: Main.overview?._inWindowDrag,
                grabCount: Main.layoutManager._grabHelper?._grabStack?.length ?? 'n/a',
            });
            this._zoomOutView?.add_style_class_name?.('post-probe-800');
            return GLib.SOURCE_REMOVE;
        });

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            const controls = this._getControls?.();
            const wsDisplay = controls?._workspacesDisplay;
            const thumbsBox = controls?._thumbnailsBox;
            logTime('POST-DRAG +1500ms', {
                fitMode: wsDisplay?._fitModeAdjustment?.value,
                thumbsBoxVisible: thumbsBox?.visible,
                thumbsBoxShouldShow: thumbsBox?._shouldShow,
                thumbCount: thumbsBox?._thumbnails?.length ?? 0,
                thumbVisible: thumbsBox?._thumbnails?.map?.(t => ({ visible: t.visible, state: t.state, metaIndex: t.metaWorkspace?.index?.() })),
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    // FIXME downstream: the upstream "new-workspace indicator via drop" lives
    // exclusively in ThumbnailsBox (workspaceThumbnail.js:_dropPlaceholder +
    // Main.wm.insertWorkspace). We replicate it on the main WorkspacesView in
    // FitMode.ALL, which has *no* drop-to-create support upstream.
    //
    // Both _getWorkspaceIndexAt and _getInsertWorkspaceIndex consume the same
    // sorted rect array built by _collectWorkspaceRects().
    _collectWorkspaceRects() {
        const mon = Main.layoutManager.monitors[
            Main.layoutManager.primaryIndex];
        if (!mon)
            return {rects: [], monitor: null};

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
            return {rects: [], monitor: mon};

        const rects = [];
        for (let i = 0; i < workspaces.length; i++) {
            const wsActor = workspaces[i];
            if (!wsActor || !wsActor.visible || !wsActor.metaWorkspace)
                continue;
            const [wx, wy] = wsActor.get_transformed_position();
            const [ww, wh] = wsActor.get_transformed_size();
            if (ww <= 1 || wh <= 1)
                continue;
            rects.push({
                i: wsActor.metaWorkspace.index(),
                x: Math.round(wx), y: Math.round(wy),
                w: Math.round(ww), h: Math.round(wh),
            });
        }
        rects.sort((a, b) => a.i - b.i);
        return {rects, monitor: mon};
    }

    _getWorkspaceIndexAt(x, y) {
        const {rects, monitor} = this._collectWorkspaceRects();
        if (!monitor || rects.length === 0) {
            logTime('_getWorkspaceIndexAt: no rects', {
                x: Math.round(x), y: Math.round(y),
            });
            return -1;
        }
        if (x < 0 || x > monitor.width || y < 0 || y > monitor.height) {
            return -1;
        }
        for (const r of rects) {
            if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
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
    // Gated by Meta.prefs_get_dynamic_workspaces() — same condition the
    // upstream thumbnails check enforces (workspaceThumbnail.js:836).
    // Returns -1 when dynamic workspaces are off, mirroring upstream.
    _getInsertWorkspaceIndex(x, y) {
        if (!Meta.prefs_get_dynamic_workspaces())
            return -1;
        const {rects, monitor} = this._collectWorkspaceRects();
        if (!monitor || rects.length === 0)
            return -1;
        if (x < 0 || x > monitor.width || y < 0 || y > monitor.height)
            return -1;

        // Use the first rect's y-band as a shared vertical band — works
        // because in FIT_ALL all workspaces share the same vertical band.
        const yTop = rects[0].y;
        const yBot = rects[0].y + rects[0].h;
        if (y < yTop || y > yBot)
            return -1;

        // Before first workspace
        if (rects[0].x > 0 && x < rects[0].x)
            return rects[0].i;
        // After last workspace
        const last = rects[rects.length - 1];
        if (x > last.x + last.w)
            return last.i + 1;
        // Between two consecutive workspaces
        for (let k = 0; k < rects.length - 1; k++) {
            const left = rects[k];
            const right = rects[k + 1];
            const gapStart = left.x + left.w;
            const gapEnd = right.x;
            if (x > gapStart && x < gapEnd)
                return right.i;
        }
        return -1;
    }

    // Returns the rect metadata for visual placement of the placeholder
    // when an insert cursor is at `insertIndex`. Dimensions match the
    // upstream thumbnails placeholder: 18px wide, 32px tall (from
    // gnome-shell-theme .placeholder CSS + workspace-placeholder.svg).
    // The placeholder is vertically centered in the gap between
    // workspace panels, mirroring upstream ThumbnailsBox vfunc_allocate
    // (workspaceThumbnail.js:1365-1390).
    _getInsertRect(insertIndex) {
        const {rects} = this._collectWorkspaceRects();
        if (rects.length === 0)
            return null;
        const PH_W = 24;
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
                }
            }
        }
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
        return params?.finalState === 2; // ControlsState.APP_GRID
    }
}
