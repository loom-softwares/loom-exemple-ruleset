import { esc } from './helpers.mjs';

/** Input URLs are validated by the sheet before reaching this renderer. */
export function portraitMedia(url, className, alt = '') {
  if (!url) return '';
  if (/\.(webm|mp4|mov)(?:[?#]|$)/i.test(url)) {
    return `<video class="${esc(className)}" src="${esc(url)}" aria-label="${esc(alt)}" muted loop autoplay playsinline></video>`;
  }
  return `<img class="${esc(className)}" src="${esc(url)}" alt="${esc(alt)}" loading="lazy">`;
}

/** Coordinates for a square crop, always within the source image. */
export function portraitCrop(width, height, zoom = 1, x = 50, y = 50) {
  const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || min));
  const size = Math.min(width, height) / clamp(zoom, 1, 4);
  return { sx: (width - size) * clamp(x, 0, 100) / 100,
    sy: (height - size) * clamp(y, 0, 100) / 100, size };
}
