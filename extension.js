import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ZOOM_OUT_DURATION = 800;
const ZOOM_IN_DURATION = 400;

export default class SpatialWorkspaceExtension extends Extension {
  enable() {
    this._dragActive = false;

    this._ids = [
      Main.overview.connect('window-drag-begin', this._onDragBegin.bind(this)),
      Main.overview.connect('window-drag-end', this._onDragEnd.bind(this)),
      Main.overview.connect('window-drag-cancelled', this._onDragEnd.bind(this)),
    ];
  }

  disable() {
    if (this._dragActive)
      this._onDragEnd();

    this._ids?.forEach(id => Main.overview.disconnect(id));
    this._ids = null;
  }

  _onDragBegin() {
    const ws = Main.overview._controls?._workspacesDisplay;
    if (!ws)
      return;

    this._dragActive = true;

    ws._fitModeAdjustment.connectObject('notify::value', () => {
      this._keepVisible(ws);
    }, this);

    ws._fitModeAdjustment.ease(1, {
      duration: ZOOM_OUT_DURATION,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }

  _onDragEnd() {
    if (!this._dragActive)
      return;

    this._dragActive = false;

    const ws = Main.overview._controls?._workspacesDisplay;
    ws?._fitModeAdjustment?.disconnectObject(this);

    ws?._fitModeAdjustment?.ease(0, {
      duration: ZOOM_IN_DURATION,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }

  _keepVisible(ws) {
    for (const view of ws._workspacesViews ?? [])
      for (const w of view?._workspaces ?? [])
        if (w?.stateAdjustment)
          w.stateAdjustment.value = 1;
  }
}
