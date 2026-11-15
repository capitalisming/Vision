// AI-assisted (Claude Code), reviewed by a team member.
// Which camera the app uses for distance tracking: one of this computer's cameras, or a Raspberry Pi running
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
    const out = { source: saved.source, piUrl: saved.piUrl };
    // A chosen camera of this computer (deviceId from enumerateDevices); without one the browser picks.
    if (saved.source === 'local' && typeof saved.deviceId === 'string' && saved.deviceId) {
      out.deviceId = saved.deviceId;
      out.deviceLabel = typeof saved.deviceLabel === 'string' ? saved.deviceLabel : '';
    }
    return out;
  }
  return { source: 'local', piUrl: '' };
}

export function saveCameraSettings(settings, storage = globalThis.localStorage) {
  const out = { source: settings.source, piUrl: settings.piUrl };
  if (settings.source === 'local' && settings.deviceId) {
    out.deviceId = settings.deviceId;
    out.deviceLabel = settings.deviceLabel ?? '';
  }
  storage.setItem(KEY, JSON.stringify(out));
}

/**
 * Keeps the distance calibrations of different cameras apart: '' for the browser's default camera,
 * 'dev:<deviceId>' for a chosen camera of this computer, 'pi:<origin>' for a Pi.
 */
export function cameraId(settings, pageOrigin) {
  if (settings.source === 'pi') return `pi:${normalizePiUrl(settings.piUrl, pageOrigin)}`;
  return settings.deviceId ? `dev:${settings.deviceId}` : '';
}

export function describeCamera(settings, pageOrigin) {
  if (settings.source !== 'pi') return settings.deviceId ? (settings.deviceLabel || 'chosen camera') : 'this computer';
  return `Raspberry Pi (${normalizePiUrl(settings.piUrl, pageOrigin).replace(/^https?:\/\//, '')})`;
}
