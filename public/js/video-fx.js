// Product video effects (map of videos comes from lib/videos.js as window.__VIDEOS__):
//  1. Product cards (homepage .pi, shop .sp-img) with a video get a small "▶"
//     badge; on mouse devices, hovering the card plays the short silent loop.
//  2. <video data-inview> (homepage reel) plays while on screen, pauses off it.
// Respects prefers-reduced-motion and Save-Data: no autoplay, poster only.
(function () {
  var VIDEOS = window.__VIDEOS__ || {};
  if (!Object.keys(VIDEOS).length) return;

  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var saveData = navigator.connection && navigator.connection.saveData;
  var canHover = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
  var motionOk = !reduce && !saveData;

  var css = document.createElement('style');
  css.textContent =
    '.vfx-badge{position:absolute;left:.7rem;bottom:.7rem;z-index:3;display:flex;align-items:center;gap:.35rem;' +
    'padding:.28rem .55rem;background:rgba(11,9,8,.72);border:1px solid rgba(201,165,92,.45);color:#c9a55c;' +
    'font-size:.55rem;font-weight:500;line-height:1;letter-spacing:.18em;text-transform:uppercase;pointer-events:none;' +
    'backdrop-filter:blur(4px);transition:opacity .4s}' +
    '.vfx-badge svg{width:8px;height:8px;fill:currentColor}' +
    '.vfx-hover{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:2;opacity:0;' +
    'transition:opacity .45s ease;pointer-events:none}' +
    '.vfx-on .vfx-hover{opacity:1}.vfx-on .vfx-badge{opacity:0}';
  document.head.appendChild(css);

  var PLAY = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 0l9 5-9 5z"/></svg>';
  var CARD_SEL = 'a.pi[href^="/products/"], a.sp-img[href^="/products/"]';

  function slugOf(a) {
    var m = /^\/products\/([^/?#]+)/.exec(a.getAttribute('href') || '');
    return m && VIDEOS[m[1]] ? m[1] : null;
  }

  function decorate(root) {
    (root || document).querySelectorAll(CARD_SEL).forEach(function (a) {
      if (a.dataset.vfx || !slugOf(a)) return;
      a.dataset.vfx = '1';
      if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
      var b = document.createElement('span');
      b.className = 'vfx-badge';
      b.innerHTML = PLAY + 'Video';
      a.appendChild(b);
    });
  }

  // Hover preview: the <video> is only created on first hover, so cards cost
  // nothing until someone points at one.
  if (canHover && motionOk) {
    document.addEventListener('mouseover', function (e) {
      var a = e.target.closest && e.target.closest(CARD_SEL);
      if (!a || a.contains(e.relatedTarget)) return;
      var slug = slugOf(a);
      if (!slug) return;
      var v = a.querySelector('video.vfx-hover');
      if (!v) {
        v = document.createElement('video');
        v.className = 'vfx-hover';
        v.muted = true; v.loop = true; v.playsInline = true;
        v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
        v.preload = 'auto';
        v.src = VIDEOS[slug].loop;
        a.appendChild(v);
      }
      a.classList.add('vfx-on');
      var p = v.play(); if (p && p.catch) p.catch(function () {});
    });
    document.addEventListener('mouseout', function (e) {
      var a = e.target.closest && e.target.closest(CARD_SEL);
      if (!a || a.contains(e.relatedTarget)) return;
      a.classList.remove('vfx-on');
      var v = a.querySelector('video.vfx-hover');
      if (v) v.pause();
    });
  }

  // Autoplay-in-view videos (homepage reel). Without motion they keep their
  // poster and native controls, and play only when the visitor asks.
  function wireInView() {
    var vids = document.querySelectorAll('video[data-inview]');
    if (!vids.length) return;
    if (!motionOk || !('IntersectionObserver' in window)) {
      vids.forEach(function (v) { v.controls = true; });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var v = en.target;
        if (en.isIntersecting) {
          if (!v.src && v.dataset.src) v.src = v.dataset.src;
          var p = v.play(); if (p && p.catch) p.catch(function () {});
        } else {
          v.pause();
        }
      });
    }, { threshold: 0.35 });
    vids.forEach(function (v) { io.observe(v); });
  }

  function init() {
    decorate();
    wireInView();
    // The homepage grid is re-rendered when a filter is clicked.
    ['productsGrid', 'shopGrid'].forEach(function (id) {
      var g = document.getElementById(id);
      if (g && 'MutationObserver' in window) new MutationObserver(function () { decorate(g); }).observe(g, { childList: true });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
