(() => {
  'use strict';
  if (globalThis.__comicTranslationOverlay) return;
  const root = document.createElement('div');
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none!important;';
  document.documentElement.appendChild(root);
  const groups = [];
  let revision = 0;
  const clear = () => { root.replaceChildren(); groups.length = 0; };
  const invalidate = () => { revision += 1; clear(); };
  const ensureRoot = () => {
    if (!root.isConnected) {
      clear();
      document.documentElement.appendChild(root);
    }
  };
  // DOM image changes, internal reader scrolling and viewport resizing can invalidate coordinates.
  addEventListener('popstate', invalidate);
  addEventListener('hashchange', invalidate);
  addEventListener('resize', invalidate);
  visualViewport?.addEventListener('resize', invalidate);
  visualViewport?.addEventListener('scroll', () => { revision += 1; });
  addEventListener('scroll', event => {
    revision += 1;
    if (event.target !== document && event.target !== window) clear();
  }, true);
  document.addEventListener('load', event => {
    if (event.target instanceof HTMLImageElement) invalidate();
  }, true);
  new MutationObserver(records => {
    if (records.some(r => r.type === 'attributes' && r.target instanceof HTMLImageElement ||
      r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].some(n =>
        n.nodeType === 1 && (n.tagName === 'IMG' || n.querySelector?.('img'))))) invalidate();
  }).observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:['src','srcset','style','class']});

  function state() {
    const v = visualViewport;
    const width = v?.width ?? innerWidth;
    const height = v?.height ?? innerHeight;
    const candidates = [];
    const offsetX = v?.offsetLeft ?? 0;
    const offsetY = v?.offsetTop ?? 0;
    let pendingImages = 0;
    const images = [...document.images].filter(image => {
      const r = image.getBoundingClientRect();
      return r.right > offsetX && r.bottom > offsetY &&
        r.left < offsetX + width && r.top < offsetY + height;
    }).slice(0, 40).map(image => {
      const r = image.getBoundingClientRect();
      const left = Math.max(0, r.left - offsetX);
      const top = Math.max(0, r.top - offsetY);
      const right = Math.min(width, r.right - offsetX);
      const bottom = Math.min(height, r.bottom - offsetY);
      const visibleWidth = Math.max(0, right - left);
      const visibleHeight = Math.max(0, bottom - top);
      const isLarge = r.width >= width * 0.5 && visibleHeight >= height * 0.35;
      if (isLarge && (!image.complete || !image.naturalWidth)) pendingImages += 1;
      const labels = `${image.alt ?? ''} ${image.id ?? ''} ${image.className ?? ''}`;
      const excluded = image.closest('nav,header,aside,[role="navigation"],[role="banner"]') ||
        /\b(advert|advertisement|banner|cover|thumbnail|thumb)\b/i.test(labels);
      if (isLarge && image.complete && image.naturalWidth >= 300 && image.naturalHeight >= 300 && !excluded)
        candidates.push({area:visibleWidth * visibleHeight / Math.max(1, width * height),
          x:1000 * left / width, y:1000 * top / height,
          w:Math.min(1000 - 1000 * left / width, 1000 * visibleWidth / width),
          h:Math.min(1000 - 1000 * top / height, 1000 * visibleHeight / height)});
      return [image.currentSrc, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), image.naturalWidth, image.naturalHeight, image.complete];
    });
    // Known directory routes and labeled thumbnails are never automatic translation targets.
    const directory = /^\/(?:title|titles|search|list)(?:\/|$)/i.test(location.pathname) ||
      /^\/(?:comic|manga)\/[^/]+\/?$/i.test(location.pathname);
    return {href:location.href, x:v?.pageLeft ?? scrollX, y:v?.pageTop ?? scrollY,
      width, height, scale:v?.scale ?? 1, signature:JSON.stringify(images), revision,
      comicCandidate:!directory && candidates.some(candidate => candidate.area >= 0.3),
      comicRects:directory ? [] : candidates.filter(candidate => candidate.area >= 0.3)
        .map(({x,y,w,h}) => ({x,y,w,h})), pendingImages};
  }
  function validRect(r) {
    return r && [r.x,r.y,r.w,r.h].every(Number.isFinite) && r.x >= 0 && r.y >= 0 &&
      r.w > 0 && r.h > 0 && r.x + r.w <= 1000 && r.y + r.h <= 1000;
  }
  function position(element, r, viewport) {
    element.style.position = 'absolute';
    element.style.left = `${r.x * viewport.width / 1000}px`;
    element.style.top = `${r.y * viewport.height / 1000}px`;
    element.style.width = `${r.w * viewport.width / 1000}px`;
    element.style.height = `${r.h * viewport.height / 1000}px`;
    element.style.pointerEvents = 'none';
  }
  function apply(payload) {
    ensureRoot();
    const viewport = payload.viewport;
    if (!viewport || ![viewport.x,viewport.y,viewport.width,viewport.height].every(Number.isFinite) ||
      viewport.width <= 0 || viewport.height <= 0 || !Array.isArray(payload.regions) || payload.regions.length > 100)
      throw new Error('Invalid translation viewport');
    const now = state();
    if (now.href !== viewport.href || now.signature !== viewport.signature || now.revision !== viewport.revision ||
      Math.abs(now.x - viewport.x) >= 1 || Math.abs(now.y - viewport.y) >= 1 ||
      Math.abs(now.width - viewport.width) >= 1 || Math.abs(now.height - viewport.height) >= 1 ||
      Math.abs(now.scale - viewport.scale) >= 0.001) throw new Error('Viewport changed before overlay application');
    const group = document.createElement('div');
    group.style.cssText = `all:initial;position:absolute;left:${viewport.x}px;top:${viewport.y}px;width:${viewport.width}px;height:${viewport.height}px;pointer-events:none!important;`;
    root.appendChild(group);
    let applied = 0;
    for (const region of payload.regions) {
      if (!validRect(region.erase) || !validRect(region.box) || typeof region.translation !== 'string' ||
        region.translation.length > 1000 || !/^#[a-fA-F0-9]{6}$/.test(region.background) ||
        !/^#[a-fA-F0-9]{6}$/.test(region.foreground)) continue;
      const mask = document.createElement('div');
      mask.style.cssText = 'all:initial;pointer-events:none!important;';
      position(mask, region.erase, viewport);
      mask.style.backgroundColor = region.background;
      const text = document.createElement('div');
      text.style.cssText = 'all:initial;pointer-events:none!important;';
      position(text, region.box, viewport);
      text.style.cssText += `;color:${region.foreground};font-family:-apple-system,'PingFang SC',sans-serif;line-height:1.2;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere;box-sizing:border-box;`;
      text.textContent = region.translation;
      group.append(mask, text);
      let size = Math.min(30, region.box.h * viewport.height / 1000 * 0.7);
      let fits = false;
      for (; size >= 6; size -= 0.5) {
        text.style.fontSize = `${size}px`;
        if (text.scrollHeight <= text.clientHeight + 1 && text.scrollWidth <= text.clientWidth + 1) { fits = true; break; }
      }
      if (!fits) { mask.remove(); text.remove(); continue; }
      text.style.display = 'flex';
      text.style.alignItems = 'center';
      text.style.justifyContent = 'center';
      applied += 1;
    }
    // Replace earlier screen translations which overlap this capture to avoid doubled lettering.
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const old = groups[i];
      if (old.viewport.x < viewport.x + viewport.width && old.viewport.x + old.viewport.width > viewport.x &&
        old.viewport.y < viewport.y + viewport.height && old.viewport.y + old.viewport.height > viewport.y) {
        old.element.remove(); groups.splice(i, 1);
      }
    }
    groups.push({element:group, viewport});
    while (groups.length > 12) groups.shift().element.remove();
    return applied;
  }
  globalThis.__comicTranslationOverlay = Object.freeze({state, apply, clear,
    visibility(visible) { ensureRoot(); root.style.visibility = visible ? 'visible' : 'hidden'; }});
})();
