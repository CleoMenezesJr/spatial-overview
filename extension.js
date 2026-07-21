import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ZOOM_OUT_DURATION = 800;
const ZOOM_IN_DURATION = 400;

export default class SpatialWorkspaceExtension extends Extension {
  enable() {
    this._dragActive = false;
    this._savedFitModeDesc = null;

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
    const wsDisplay = Main.overview._controls?._workspacesDisplay;
    if (!wsDisplay)
      return;

    this._dragActive = true;
    wsDisplay.add_style_class_name('drag-active');

    this._fakeFitMode(wsDisplay);

    const fitAdj = wsDisplay._fitModeAdjustment;
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

    const wsDisplay = Main.overview._controls?._workspacesDisplay;

    this._dragActive = false;
    wsDisplay?.remove_style_class_name('drag-active');

    this._unfakeFitMode(wsDisplay);

    const fitAdj = wsDisplay?._fitModeAdjustment;
    if (fitAdj)
      fitAdj.ease(0, {
        duration: ZOOM_IN_DURATION,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
  }

  _fakeFitMode(wsDisplay) {
    if (this._savedFitModeDesc)
      return;

    const realAdj = wsDisplay._fitModeAdjustment;

    // Proxy that always reports value = 1 (ALL) to _update()
    const fakeAdj = Object.create(realAdj);
    Object.defineProperty(fakeAdj, 'value', {
      get: () => 1,
      set: () => { /* _update() tries to snap → ignore */ },
      configurable: true,
      enumerable: true,
    });

    // Replace the public getter so _update() reads the fake
    this._savedFitModeDesc =
      Object.getOwnPropertyDescriptor(wsDisplay, 'fitModeAdjustment');

    Object.defineProperty(wsDisplay, 'fitModeAdjustment', {
      get: () => fakeAdj,
      configurable: true,
      enumerable: true,
    });
  }

  _unfakeFitMode(wsDisplay) {
    if (!this._savedFitModeDesc || !wsDisplay)
      return;

    Object.defineProperty(wsDisplay, 'fitModeAdjustment', this._savedFitModeDesc);
    this._savedFitModeDesc = null;
  }
}
