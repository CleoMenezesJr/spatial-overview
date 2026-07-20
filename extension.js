import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ZOOM_OUT_DURATION = 800;
const ZOOM_IN_DURATION = 400;

export default class SpatialWorkspaceExtension extends Extension {
  enable() {
    this._dragActive = false;
    this._originalGetFitMode = null;

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

    Main.overview._controls?._workspacesDisplay?.remove_style_class_name('drag-active');
  }

  _onDragBegin() {
    const controls = Main.overview._controls;
    if (!controls)
      return;

    this._dragActive = true;
    controls._workspacesDisplay?.add_style_class_name('drag-active');

    this._overrideGetFitMode(controls);

    const fitAdj = controls._workspacesDisplay?._fitModeAdjustment;
    if (!fitAdj)
      return;

    fitAdj.ease(1, {
      duration: ZOOM_OUT_DURATION,
      mode: Clutter.AnimationMode.EASE_OUT_BOUNCE,
    });
  }

  _onDragEnd() {
    if (!this._dragActive)
      return;

    const controls = Main.overview._controls;
    if (!controls)
      return;

    this._dragActive = false;
    controls._workspacesDisplay?.remove_style_class_name('drag-active');

    this._restoreGetFitMode(controls);

    const fitAdj = controls._workspacesDisplay?._fitModeAdjustment;
    if (fitAdj)
      fitAdj.ease(0, {
        duration: ZOOM_IN_DURATION,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
  }

  _overrideGetFitMode(controls) {
    if (this._originalGetFitMode)
      return;

    this._originalGetFitMode = controls._getFitModeForState.bind(controls);

    controls._getFitModeForState = (_state) => {
      if (this._dragActive)
        return 1; // FitMode.ALL

      return this._originalGetFitMode(_state);
    };
  }

  _restoreGetFitMode(controls) {
    if (!this._originalGetFitMode)
      return;

    controls._getFitModeForState = this._originalGetFitMode;
    this._originalGetFitMode = null;
  }
}
