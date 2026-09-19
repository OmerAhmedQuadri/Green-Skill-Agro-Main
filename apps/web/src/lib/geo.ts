import { ApiError } from './api';

export type Position = { lat: number; lng: number; accuracyM: number };

/**
 * NFR-004, ATT-013: the phone's location, asked for once, at the moment of an
 * event — never watched. Needs HTTPS and the user's permission.
 */
export function currentPosition(timeoutMs = 20_000): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject(new ApiError(0, 'LOCATION_UNAVAILABLE'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }),
      (e) => reject(new ApiError(0, e.code === e.PERMISSION_DENIED ? 'LOCATION_DENIED' : 'LOCATION_UNAVAILABLE')),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}
