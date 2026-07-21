import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

const {APP_GRID, WINDOW_PICKER} = OverviewControls.ControlsState;
const ZOOM_OUT_DURATION = 800;
const ZOOM_IN_DURATION = 400;

export default class SpatialWorkspaceExtension extends Extension {
  enable() {
    this._dragActive = false;
    this._saved = {};

    this._ids = [
      Main.overview.connect('window-drag-begin', this._onDragBegin.bind(this)),
      Main.overview.connect('window-drag-end', this._onDragEnd.bind(this)),
      Main.overview.connect('window-drag-cancelled', this._onDragEnd.bind(this)),
    ];
  }

  disable() {
    if (this._dragActive) {
      const c = Main.overview._controls;
      c?._stateAdjustment?.remove_transition('value');
      this._restoreAll(c, c?._workspacesDisplay);
      c?._stateAdjustment?.set({value: WINDOW_PICKER});
    }
    this._ids?.forEach(id => Main.overview.disconnect(id));
    this._ids = null;
    Main.overview._controls?._workspacesDisplay?.remove_style_class_name('drag-active');
  }

  _onDragBegin() {
    const controls = Main.overview._controls;
    const ws = controls?._workspacesDisplay;
    if (!controls || !ws) return;

    controls._stateAdjustment?.remove_transition('value');
    this._restoreAll(controls, ws);

    this._dragActive = true;
    ws.add_style_class_name('drag-active');

    this._patch(controls, ws);

    ws._fitModeAdjustment.connectObject('notify::value', () => {
      for (const v of ws._workspacesViews ?? [])
        for (const w of v?._workspaces ?? [])
          if (w?.stateAdjustment) w.stateAdjustment.value = 1;
    }, this);

    controls._stateAdjustment.ease(APP_GRID, {
      duration: ZOOM_OUT_DURATION,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }

  _onDragEnd() {
    if (!this._dragActive) return;
    this._dragActive = false;

    const controls = Main.overview._controls;
    const ws = controls?._workspacesDisplay;

    ws?.remove_style_class_name('drag-active');
    ws?._fitModeAdjustment?.disconnectObject(this);

    this._restoreSideEffects(controls);

    controls?._stateAdjustment?.ease(WINDOW_PICKER, {
      duration: ZOOM_IN_DURATION,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => this._restoreComputeBox(controls),
    });
  }

  _patch(controls, ws) {
    this._saved = {};

    const layout = controls.layout_manager;
    if (layout?._computeWorkspacesBoxForState) {
      const orig = layout._computeWorkspacesBoxForState.bind(layout);
      this._saved.computeBox = {obj: layout, fn: orig};
      layout._computeWorkspacesBoxForState = (state, ...args) =>
        state === APP_GRID ? orig(WINDOW_PICKER, ...args) : orig(state, ...args);
    }

    if (controls._updateAppDisplayVisibility) {
      this._saved.appVis = controls._updateAppDisplayVisibility.bind(controls);
      controls._updateAppDisplayVisibility = () => {};
    }

    if (controls.showPage) {
      this._saved.showPage = controls.showPage.bind(controls);
      controls.showPage = () => {};
    }
  }

  _restoreSideEffects(c) {
    if (this._saved.appVis && c) {
      c._updateAppDisplayVisibility = this._saved.appVis;
      delete this._saved.appVis;
    }
    if (this._saved.showPage && c) {
      c.showPage = this._saved.showPage;
      delete this._saved.showPage;
    }
  }

  _restoreComputeBox(c) {
    if (this._saved.computeBox) {
      this._saved.computeBox.obj._computeWorkspacesBoxForState =
        this._saved.computeBox.fn;
      delete this._saved.computeBox;
    }
  }

  _restoreAll(c, ws) {
    this._restoreSideEffects(c);
    this._restoreComputeBox(c);
    ws?.remove_style_class_name('drag-active');
    ws?._fitModeAdjustment?.disconnectObject(this);
  }
}
