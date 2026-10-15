// The core layered portrait editor only accepts actor IDs. Items use their own
// small editor with the public file picker and upload API; no temporary actors.
import { esc } from '../lib/helpers.mjs';
import { portraitMedia, portraitCrop } from '../lib/portrait.mjs';
import { safeImageUrl } from '../sheets/item-view.mjs';

const Base = globalThis.Loom?.BaseWindow ?? class {};
function t(key, fallback) {
  const value = globalThis.Loom?.i18n?.localize?.(`sandbox.portrait.${key}`);
  return value && value !== `sandbox.portrait.${key}` ? value : fallback;
}
const video = (url) => /\.(webm|mp4|mov|gif)(?:[?#]|$)/i.test(url);

export class ItemPortraitEditor extends Base {
  constructor(props) {
    super({ id: `ldm-item-portrait-${props.itemId}`, title: t('title', 'Item image'),
      width: 470, height: 'auto', showFooter: false, resizable: true });
    this.props = props;
    this.url = safeImageUrl(props.url);
    this.zoom = 1;
    this.x = this.y = 50;
    this.crop = false;
    this.busy = false;
    this.source = null;
    this.error = '';
  }

  bodyTemplate() {
    const slider = (field, label, min, max, step) => `<label class="ldm-editor-field"><span>${esc(label)}</span><input type="range" data-adjust="${field}" min="${min}" max="${max}" step="${step}" value="${this[field]}"></label>`;
    return `<div class="ldm-editor-root ldm-portrait-editor">
      <p>${esc(t('hint', 'Choose an image, then optionally adjust its square crop. Your original file is kept.'))}</p>
      <div class="ldm-portrait-preview">${this.crop ? '<canvas width="512" height="512"></canvas>' : portraitMedia(this.url, 'ldm-portrait-media')}</div>
      <div class="ldm-editor-actions">
        <label class="ldm-editor-btn">${esc(t('upload', 'Upload image'))}<input type="file" data-upload accept="image/png,image/jpeg,image/webp,image/gif,video/webm,video/mp4"${this.busy ? ' disabled' : ''}></label>
        <button type="button" class="ldm-editor-btn" data-action="portrait-library"${this.busy ? ' disabled' : ''}>${esc(t('library', 'Choose from files'))}</button>
      </div>
      ${this.url && !video(this.url) ? `<label><input type="checkbox" data-adjust="crop"${this.crop ? ' checked' : ''}> ${esc(t('crop', 'Adjust square crop'))}</label>` : ''}
      ${this.crop ? slider('zoom', t('zoom', 'Zoom'), 1, 4, 0.05) + slider('x', t('horizontal', 'Horizontal position'), 0, 100, 1) + slider('y', t('vertical', 'Vertical position'), 0, 100, 1) : ''}
      ${this.error ? `<p role="alert" class="ldm-editor-errors">${esc(this.error)}</p>` : ''}
      <button type="button" class="ldm-editor-btn ldm-editor-primary" data-action="portrait-save"${!this.url || this.busy ? ' disabled' : ''}>${esc(this.busy ? t('saving', 'Saving…') : t('apply', 'Apply image'))}</button>
    </div>`;
  }

  onRender() {
    if (this.boundRoot !== this.element) {
      this.boundRoot = this.element;
      this.element.addEventListener('change', (event) => {
        if (event.target.matches('[data-upload]')) void this.uploadFile(event.target.files?.[0]);
        if (event.target.dataset.adjust === 'crop' && !this.busy) {
          this.crop = event.target.checked;
          this.rerenderBody();
        }
      });
      this.element.addEventListener('input', (event) => {
        const field = event.target.dataset.adjust;
        if (['zoom', 'x', 'y'].includes(field) && !this.busy) {
          this[field] = Number(event.target.value);
          this.draw();
        }
      });
    }
    if (this.crop) void this.loadImage();
  }

  async loadImage() {
    const url = this.url;
    try {
      if (this.source?.src !== new URL(url, location.href).href) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = url;
        await img.decode();
        if (url !== this.url || this.closed) return;
        this.source = img;
      }
      this.draw();
    } catch {
      this.crop = false;
      this.error = t('cropFailed', 'This image cannot be cropped. Upload a local image, or apply it without cropping.');
      if (!this.closed) this.rerenderBody();
    }
  }

  draw() {
    const canvas = this.element?.querySelector('canvas');
    if (!canvas || !this.source) return;
    const { sx, sy, size } = portraitCrop(this.source.naturalWidth, this.source.naturalHeight, this.zoom, this.x, this.y);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 512);
    ctx.drawImage(this.source, sx, sy, size, size, 0, 0, 512, 512);
  }

  async upload(blob, name) {
    const data = new FormData();
    data.append('file', blob, name);
    const world = globalThis.Loom?.world?.id || globalThis.Loom?.wsClient?.session?.worldId || '';
    const response = await fetch(`/api/assets/upload?worldId=${encodeURIComponent(world)}`, { method: 'POST', body: data, credentials: 'same-origin' });
    const result = await response.json();
    if (!response.ok || !result.path) throw new Error(t('uploadFailed', 'Could not upload the image.'));
    const url = safeImageUrl(result.path.startsWith('/') || /^https?:/.test(result.path) ? result.path : `/${result.path}`);
    if (!url) throw new Error(t('uploadFailed', 'Could not upload the image.'));
    return url;
  }

  async uploadFile(file) {
    if (!file || this.busy || !this.props.canEdit()) return;
    this.busy = true;
    this.error = '';
    this.rerenderBody();
    try { this.select(await this.upload(file, file.name)); }
    catch (error) { this.error = error.message; }
    finally { this.busy = false; if (!this.closed) this.rerenderBody(); }
  }

  select(url) {
    const safe = safeImageUrl(url);
    if (!safe) return;
    this.url = safe;
    this.crop = false;
    this.source = null;
    this.zoom = 1;
    this.x = this.y = 50;
    this.error = '';
    if (!this.closed) this.rerenderBody();
  }

  async onAction(action) {
    if (this.busy || !this.props.canEdit()) return;
    const loom = globalThis.Loom;
    if (action === 'portrait-library') {
      return loom.windowManager.open('file-picker', loom.windows.FilePickerWindow, { onSelect: (url) => this.select(url) });
    }
    if (action !== 'portrait-save' || !this.url) return;
    this.busy = true;
    this.error = '';
    try {
      let url = this.url;
      if (this.crop) {
        await this.loadImage();
        if (!this.crop) throw new Error(this.error);
        const canvas = this.element.querySelector('canvas');
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error(t('uploadFailed', 'Could not upload the image.'));
        url = await this.upload(blob, `item-${this.props.itemId}-${Date.now()}.png`);
      }
      if (!this.props.canEdit()) return;
      await this.props.save(url);
      loom.windowManager.close(this.options.id);
    } catch (error) {
      this.error = error.message;
    } finally {
      this.busy = false;
      if (!this.closed) this.rerenderBody();
    }
  }

  _onBeforeClose() { return !this.busy; }
  onClose() { this.closed = true; this.source = null; }
}

export function openItemPortraitEditor(props) {
  if (!props.canEdit()) return;
  return globalThis.Loom.windowManager.open(`ldm-item-portrait-${props.itemId}`, ItemPortraitEditor, props);
}
