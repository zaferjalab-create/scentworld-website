/* Shared wishlist: localStorage-backed save-for-later. Included site-wide via
   the header partial. Heart buttons carry data-* attributes; a delegated click
   handler toggles membership. Header badges show the count. */
(function () {
  var KEY = 'sw_wishlist';
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
  function write(a) { localStorage.setItem(KEY, JSON.stringify(a)); paint(); }
  function has(id) { return read().some(function (i) { return String(i.id) === String(id); }); }
  function remove(id) { write(read().filter(function (i) { return String(i.id) !== String(id); })); }
  function toggle(data) {
    var a = read(), id = String(data.id);
    if (a.some(function (i) { return String(i.id) === id; })) a = a.filter(function (i) { return String(i.id) !== id; });
    else a.push(data);
    write(a);
    return has(id);
  }
  function paint() {
    var a = read(), ids = {};
    a.forEach(function (i) { ids[String(i.id)] = true; });
    document.querySelectorAll('.wish-btn').forEach(function (b) {
      var on = !!ids[String(b.dataset.id)];
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('.wish-count').forEach(function (c) {
      c.textContent = a.length;
      c.classList.toggle('show', a.length > 0);
    });
  }
  // Delegated toggle for any .wish-btn on the page.
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.wish-btn');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    var d = b.dataset;
    toggle({ id: d.id, slug: d.slug, name: d.name, price: parseFloat(d.price) || 0, image_url: d.image || '', category: d.category || '' });
  });
  window.swWishlist = { read: read, has: has, remove: remove, toggle: toggle, paint: paint };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
  else paint();
})();
