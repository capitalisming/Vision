// AI-assisted (Claude Code), reviewed by a team member.
// Which camera the app uses for distance tracking: this computer's webcam, or a Raspberry Pi running
// pi/camera_server.py. The choice is remembered in this browser only.
import { normalizePiUrl } from './pi-camera.js';

const KEY = 'camera_settings';

/** Saved choice, or the default (this computer) when nothing valid is saved. */
export function loadCameraSettings(storage = globalThis.localStorage) {
  let saved = null;
  try {
    saved = JSON.parse(storage?.getItem(KEY) ?? 'null');
  } catch {
    // A damaged value is treated like no value: the user simply picks the camera again.
  }
  if (saved && (saved.source === 'local' || saved.source === 'pi') && typeof saved.piUrl === 'string') {
    return { source: saved.source, piUrl: saved.piUrl };
  }
  return { source: 'local', piUrl: '' };
}

export function saveCameraSettings(settings, storage = globalThis.localStorage) {
  storage.setItem(KEY, JSON.stringify({ source: settings.source, piUrl: settings.piUrl }));
}

/** Keeps the distance calibrations of different cameras apart: '' for the webcam, 'pi:<origin>' for a Pi. */
export function cameraId(settings, pageOrigin) {
  return settings.source === 'pi' ? `pi:${normalizePiUrl(settings.piUrl, pageOrigin)}` : '';
}

export function describeCamera(settings, pageOrigin) {
  if (settings.source !== 'pi') return 'this computer';
  return `Raspberry Pi (${normalizePiUrl(settings.piUrl, pageOrigin).replace(/^https?:\/\//, '')})`;
}
