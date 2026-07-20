import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ZOOM_OUT_DURATION = 800;
const ZOOM_IN_DURATION = 400;

export default class SpatialWorkspaceExtension extends Extension {
  enable() {
    this._dragActive = false;
    this._originalUpdate = null;

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

    this._patchUpdate(controls);

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

    this._unpatchUpdate(controls);

    const fitAdj = controls._workspacesDisplay?._fitModeAdjustment;
    if (fitAdj)
      fitAdj.ease(0, {
        duration: ZOOM_IN_DURATION,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
  }

  _patchUpdate(controls) {
    if (this._originalUpdate)
      return;

    this._originalUpdate = controls._update.bind(controls);
    const extension = this;

    controls._update = function () {
      const fitModeAdjustment = this._workspacesDisplay?.fitModeAdjustment;
      const savedProp = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(fitModeAdjustment), 'value');

      if (extension._dragActive && savedProp) {
        Object.defineProperty(fitModeAdjustment, 'value', {
          set() { /* block _update from snapping fit mode */ },
          get() { return savedProp.get.call(this); },
          configurable: true,
          enumerable: true,
        });
      }

      try {
        extension._originalUpdate();
      } finally {
        if (savedProp)
          Object.defineProperty(fitModeAdjustment, 'value', savedProp);
      }
    };
  }

  _unpatchUpdate(controls) {
    if (!this._originalUpdate)
      return;

    controls._update = this._originalUpdate;
    this._originalUpdate = null;
  }
}
