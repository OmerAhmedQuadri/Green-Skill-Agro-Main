'use client';

import { Camera, RefreshCw, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from '@gsa/ui';
import { ApiError } from '@/lib/api';
import { useErrorText } from '@/lib/hooks';
import { compressPhoto, uploadMedia, type Capture, type MediaKind } from '@/lib/upload';

type Shot = { mediaId: string; url: string; bytes: number; width: number; height: number; sourceWidth: number; sourceHeight: number };

/**
 * NFR-003, NFR-009 (ARCHITECTURE §6.4): a photo from the live camera — no
 * gallery, so an old picture cannot pass as today's. The frame is compressed
 * in the browser (long edge ≤ 1600 px, JPEG) before it is uploaded; the
 * finished photo carries its size so a test can prove it.
 */
export function PhotoCapture({ id, kind, label, capture, onChange }: {
  id: string; kind: Extract<MediaKind, 'SELFIE' | 'ODOMETER' | 'WRITE_OFF_EVIDENCE'>; label: string;
  capture?: Capture; onChange: (mediaId: string | null) => void;
}) {
  const t = useTranslations('camera');
  const errorText = useErrorText();
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const stop = (s: MediaStream | null) => s?.getTracks().forEach((track) => track.stop());
  useEffect(() => () => stop(stream), [stream]);
  useEffect(() => {
    if (video.current && stream) {
      video.current.srcObject = stream;
      void video.current.play().catch(() => undefined);
    }
  }, [stream]);

  const open = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) { setError(new ApiError(0, 'CAMERA_UNAVAILABLE')); return; }
    try {
      setStream(await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: kind === 'SELFIE' ? 'user' : 'environment', width: { ideal: 2560 }, height: { ideal: 1920 } },
      }));
    } catch (e) {
      setError(new ApiError(0, e instanceof DOMException && e.name === 'NotAllowedError' ? 'CAMERA_DENIED' : 'CAMERA_UNAVAILABLE'));
    }
  };

  const take = async () => {
    const v = video.current;
    if (!v || !stream || v.videoWidth === 0) return;
    setBusy(true);
    setError(null);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext('2d')?.drawImage(v, 0, 0);
      const raw = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new ApiError(0, 'UPLOAD_FAILED'))), 'image/jpeg', 0.95));
      stop(stream);
      setStream(null);
      const small = await compressPhoto(raw);
      const bitmap = await createImageBitmap(small);
      const mediaId = await uploadMedia(kind, small, { capturedAt: new Date(), ...capture }, { compressed: true });
      setShot({ mediaId, url: URL.createObjectURL(small), bytes: small.size, width: bitmap.width, height: bitmap.height, sourceWidth: canvas.width, sourceHeight: canvas.height });
      bitmap.close();
      onChange(mediaId);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const retake = () => {
    if (shot) URL.revokeObjectURL(shot.url);
    setShot(null);
    onChange(null);
    void open();
  };

  return (
    <div className="space-y-2" id={id}>
      <div className="text-sm font-medium text-stone-800">{label}</div>
      {error ? <Alert>{errorText(error)}</Alert> : null}
      {shot ? (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, not an optimisable asset */}
          <img src={shot.url} alt={label} className="size-20 rounded-md border border-stone-200 object-cover"
            data-bytes={shot.bytes} data-width={shot.width} data-height={shot.height} data-source-width={shot.sourceWidth} data-source-height={shot.sourceHeight} />
          <div className="space-y-1 text-sm">
            <div className="font-medium text-brand-800">{t('ready')}</div>
            <Button size="sm" variant="ghost" onClick={retake}><RefreshCw className="size-4" aria-hidden />{t('retake')}</Button>
          </div>
        </div>
      ) : stream ? (
        <div className="space-y-2">
          <video ref={video} playsInline muted className="aspect-[4/3] w-full rounded-md bg-stone-900 object-cover" aria-label={t('viewfinder')} />
          <div className="flex gap-2">
            <Button onClick={() => void take()} disabled={busy}><Camera className="size-4" aria-hidden />{busy ? t('saving') : t('take')}</Button>
            <Button variant="ghost" onClick={() => { stop(stream); setStream(null); }}><X className="size-4" aria-hidden />{t('close')}</Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => void open()} disabled={busy}><Camera className="size-4" aria-hidden />{busy ? t('saving') : t('open')}</Button>
      )}
    </div>
  );
}
