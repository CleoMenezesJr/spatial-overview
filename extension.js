import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DRAG_ANIMATION_TIME = 300;

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
      this._restoreControlsUpdate();

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

    this._dragActive = false;
    Main.overview._controls?._workspacesDisplay?.remove_style_class_name('drag-active');
  }

  _onDragBegin() {
    const controls = Main.overview._controls;
    if (!controls)
      return;

    this._dragActive = true;
    Main.overview._controls?._workspacesDisplay?.add_style_class_name('drag-active');
    this._overrideControlsUpdate(controls);

    const fitAdj = controls._workspacesDisplay?._fitModeAdjustment;
    if (!fitAdj)
      return;

    fitAdj.ease(1, {
      duration: 500,
      mode: Clutter.AnimationMode.EASE_OUT_BOUNCE,
    });
  }

  _onDragEnd() {
    if (!this._dragActive)
      return;

    const controls = Main.overview._controls;
    if (!controls)
      return;

    this._restoreControlsUpdate();

    const fitAdj = controls._workspacesDisplay?._fitModeAdjustment;
    if (fitAdj)
      fitAdj.ease(0, {
        duration: DRAG_ANIMATION_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });

    this._dragActive = false;
    Main.overview._controls?._workspacesDisplay?.remove_style_class_name('drag-active');
  }

  _overrideControlsUpdate(controls) {
    if (this._originalUpdate)
      return;

    this._originalUpdate = controls._update.bind(controls);

    controls._update = () => {
      if (!this._dragActive) {
        const original = this._originalUpdate;
        this._restoreControlsUpdate();
        original();
        return;
      }

      const thumbnails = controls._thumbnailsBox;
      if (thumbnails?.should_show) {
        thumbnails.ease_property('expand-fraction', 1.0, {
          duration: 500,
          mode: Clutter.AnimationMode.EASE_OUT_BOUNCE,
        });
      }

      controls._updateAppDisplayVisibility?.();
    };
  }

  _restoreControlsUpdate() {
    if (!this._originalUpdate)
      return;

    const controls = Main.overview._controls;
    if (controls)
      controls._update = this._originalUpdate;

    this._originalUpdate = null;
  }
}
