import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

const TAG = '[SPATIAL-WS]';
const logTime = (...a) => console.log(TAG, `t=${(Date.now() % 100000)}`, ...a);
const ZOOM_OUT_DURATION = 250;
const ZOOM_IN_DURATION = 250;
const BACKDROP_OPACITY = 180;
const FIT_ALL = 1;
const FIT_SINGLE = 0;

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

    handleDragOver(_source, _dragActor, x, y, _time) {
        if (!this._extension)
            return DND.DragMotionResult.CONTINUE;
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
            'window-drag-begin', this._onDragBegin.bind(this));
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

        proto._init = function (realWindow) {
            const r = origInit.call(this, realWindow);
            try {
                if (this._draggable)
                    this._draggable._restoreOnSuccess = false;
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
        this._origWindowCloneInit = null;
        this._windowClonePatched = false;
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
        this._dragActive = false;

        if (this._zoomOutView) {
            this._zoomOutView.destroy();
            this._zoomOutView = null;
        }
    }

    _onDragBegin() {
        logTime('_onDragBegin ENTER (zoom-out will start)');
        this._dragActive = true;
        const self = this;

        this._draggedMetaWindow = null;
        this._lastCursorX = 0;
        this._lastCursorY = 0;
        this._dragMotionCount = 0;
        this._activeDraggable = null;

        this._dragMonitor = {
            dragMotion: (dragEvent) => {
                this._draggedMetaWindow = dragEvent.source?.metaWindow || this._draggedMetaWindow;
                if (!this._activeDraggable && dragEvent.source?._draggable)
                    this._activeDraggable = dragEvent.source._draggable;
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
            return false;
        }
        const wsIndex = this._getWorkspaceIndexAt(x, y);
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
        // Don't snap fitModeAdjustment here — _onDragEnd (triggered
        // synchronously by change_workspace -> window-drag-end signal)
        // owns the zoom-in ease. Snapping here would remove_transition
        // and set value=FIT_SINGLE mid-ease, skipping the animation.
        logTime('_handleDrop: change_workspace RETURNED');
        return true;
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

        const ws = this._getWsDisplay();
        const inAppGrid = this._isInAppGrid();
        const alreadyChanged = ws?._fitModeAdjustment?.value === FIT_SINGLE;
        if (!alreadyChanged && ws?._fitModeAdjustment && !inAppGrid) {
            logTime('_onDragEnd: starting zoom-in ease to FIT_SINGLE', {isCancel});
            ws._fitModeAdjustment.remove_transition('value');
            ws._fitModeAdjustment.ease(FIT_SINGLE, {
                duration: ZOOM_IN_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                // FIXME downstream: paired with the monkey-patch in
                // _onDragBegin. Restore _updateWorkspacesState after the
                // zoom-in ease completes so WindowPreviews transition
                // back to natural layout.
                onStopped: () => this._restoreWorkspacesState(),
            });
        } else {
            logTime('_onDragEnd: fitMode already FIT_SINGLE or inAppGrid, no zoom-in', {isCancel, inAppGrid});
            this._restoreWorkspacesState();
        }

        if ((isCancel || dropWasNoop) && this._activeDraggable) {
            logTime('HARMONY: hijacking _animateDragEnd', {isCancel, dropWasNoop});
            const draggable = this._activeDraggable;
            const origAnimate = draggable._animateDragEnd;
            draggable._animateDragEnd = function (eventTime, _params) {
                logTime('HARMONY: animate (instant) reached');
                return origAnimate.call(this, eventTime, {duration: 0});
            };
            try {
                const dragActor = draggable._dragActor;
                if (dragActor) {
                    dragActor.remove_all_transitions();
                    dragActor.opacity = 0;
                }
            } catch (e) {
                logTime('HARMONY: hide error', e.message);
            }
            const restoreId = draggable.connect('drag-end', () => {
                logTime('HARMONY: drag-end -> restoring _animateDragEnd');
                draggable._animateDragEnd = origAnimate;
                draggable.disconnect(restoreId);
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

    _getWorkspaceIndexAt(x, y) {
        const mon = Main.layoutManager.monitors[
            Main.layoutManager.primaryIndex];
        if (!mon)
            return -1;

        if (x < 0 || x > mon.width)
            return -1;
        if (y < 0 || y > mon.height)
            return -1;

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
        if (!workspaces || workspaces.length === 0) {
            logTime('_getWorkspaceIndexAt: no workspaces', {
                hasDisplay: !!display,
                hasWsView: !!wsView,
                viewsCount: views?.length ?? 0,
                wsCount: workspaces?.length ?? 0,
            });
            return -1;
        }

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
            if (x >= wx && x <= wx + ww && y >= wy && y <= wy + wh) {
                logTime('_getWorkspaceIndexAt: HIT', {
                    wsIndex: wsActor.metaWorkspace.index(),
                    x: Math.round(x), y: Math.round(y),
                    rect: rects[rects.length - 1],
                });
                return wsActor.metaWorkspace.index();
            }
        }
        logTime('_getWorkspaceIndexAt: MISS', {
            x: Math.round(x), y: Math.round(y),
            rects,
        });
        return -1;
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
                    lm.layout_changed();
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
