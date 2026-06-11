"""Phase 1 migration: EJS partials, consistency fixes, image fallbacks, mobile CSS."""
import re, os, shutil, sys
sys.stdout.reconfigure(encoding='utf-8')

PUB, VIEWS, LEGACY = 'public', 'views', 'legacy_html'

idx = open(f'{PUB}/index.html', encoding='utf-8').read()

# ───────────────────────── 1. CSS extraction from index.html ─────────────────────────
style = re.search(r'<style>(.*?)</style>', idx, re.DOTALL).group(1)

def split_rules(css):
    rules, medias, i, n = [], [], 0, len(css)
    while i < n:
        m = re.match(r'\s+', css[i:])
        if m: i += m.end(); continue
        if css[i:i+2] == '/*':
            j = css.find('*/', i+2); i = (j+2) if j >= 0 else n; continue
        j = css.find('{', i)
        if j < 0: break
        sel = css[i:j].strip()
        if sel.startswith('@media'):
            depth, k = 1, j+1
            while k < n and depth:
                if css[k] == '{': depth += 1
                elif css[k] == '}': depth -= 1
                k += 1
            medias.append((sel, split_rules(css[j+1:k-1])[0]))
            i = k
        elif sel.startswith('@'):
            depth, k = 1, j+1
            while k < n and depth:
                if css[k] == '{': depth += 1
                elif css[k] == '}': depth -= 1
                k += 1
            i = k
        else:
            k = css.find('}', j)
            rules.append((sel, css[j+1:k]))
            i = k+1
    return rules, medias

def matches(sel, prefixes):
    for part in sel.split(','):
        p = part.strip()
        for pre in prefixes:
            if pre.startswith('.'):
                if p.startswith(pre): return True
            else:
                if p == pre or re.match(rf'^{pre}[.\s:#]', p): return True
    return False

rules, medias = split_rules(style)

def collect(prefixes):
    out = [f'{s}{{{b}}}' for s, b in rules if matches(s, prefixes)]
    for mq, inner in medias:
        keep = [f'{s}{{{b}}}' for s, b in inner if matches(s, prefixes)]
        if keep: out.append(f'{mq}{{{"".join(keep)}}}')
    return '\n'.join(out)

HEADER_SEL = ('nav', '.nl', '.nk', '.nc', '.mb', '.mn', '.mc', '.cart-btn', '.cart-badge')
FOOTER_SEL = ('footer', '.ft', '.fb', '.fs', '.google-badge', '.gb-')
header_css = collect(HEADER_SEL)
footer_css = collect(FOOTER_SEL)

root_block = re.search(r':root\{[^}]*\}', style).group(0)

# ───────────────────────── 2. Footer markup from index ─────────────────────────
foot_m = re.search(r'<footer>.*?</footer>', idx, re.DOTALL)
footer_html = foot_m.group(0)
footer_html = re.sub(r'&copy; 20\d\d', '&copy; <%= new Date().getFullYear() %>', footer_html)
for h in ('products','spaces','about','services','contact','booking'):
    footer_html = footer_html.replace(f'href="#{h}"', f'href="/#{h}"')

# ───────────────────────── 3. Write partials ─────────────────────────
os.makedirs(f'{VIEWS}/partials', exist_ok=True)

header_ejs = f'''<style>
{root_block}
{header_css}
a.cart-btn{{text-decoration:none}}
</style>
<nav id="nav">
  <a href="/" class="nl">
    <img src="/images/logo.png" alt="Scent World Canada" style="height:40px;width:auto;object-fit:contain" onerror="this.onerror=null;this.style.display='none'">
  </a>
  <div class="nk">
    <a href="/#products">Shop</a>
    <a href="/#spaces">Spaces</a>
    <a href="/#about">Our Story</a>
    <a href="/#services">Services</a>
    <a href="/blog.html">Journal</a>
    <% if (typeof cartLive !== 'undefined' && cartLive) {{ %>
    <button class="cart-btn" id="cartBtn" aria-label="Cart">
      <svg viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
      <span class="cart-badge" id="cartBadge">0</span>
    </button>
    <% }} else {{ %>
    <a href="/?cart=open" class="cart-btn" id="cartBtn" aria-label="Cart">
      <svg viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
      <span class="cart-badge" id="cartBadge">0</span>
    </a>
    <% }} %>
    <a href="/#contact" class="nc">Get a Quote</a>
  </div>
  <button class="mb" id="mbBtn" aria-label="Menu"><span></span><span></span><span></span></button>
</nav>
<div class="mn" id="mn">
  <button class="mc" onclick="cm()">&#10005;</button>
  <a href="/#products" onclick="cm()">Shop</a>
  <a href="/#spaces" onclick="cm()">Spaces</a>
  <a href="/#about" onclick="cm()">Our Story</a>
  <a href="/#services" onclick="cm()">Services</a>
  <a href="/blog.html" onclick="cm()">Journal</a>
  <a href="/#contact" onclick="cm()">Contact</a>
  <a href="/#booking" onclick="cm()">Book Consultation</a>
</div>
<script>
window.addEventListener('scroll', function() {{ var n = document.getElementById('nav'); if (n) n.classList.toggle('sc', window.scrollY > 50); }});
function cm() {{ var m = document.getElementById('mn'); if (m) m.classList.remove('op'); }}
document.getElementById('mbBtn').onclick = function() {{ document.getElementById('mn').classList.add('op'); }};
</script>
'''

footer_ejs = f'''<style>
{footer_css}
</style>
{footer_html}
<script>
(function() {{
  document.addEventListener('error', function(e) {{
    var t = e.target;
    if (t && t.tagName === 'IMG' && !t.dataset.fbk) {{ t.dataset.fbk = '1'; t.src = '/images/placeholder.svg'; }}
  }}, true);
  window.addEventListener('load', function() {{
    document.querySelectorAll('img').forEach(function(im) {{
      if (im.complete && im.naturalWidth === 0 && !im.dataset.fbk) {{ im.dataset.fbk = '1'; im.src = '/images/placeholder.svg'; }}
    }});
  }});
  try {{
    var c = JSON.parse(localStorage.getItem('sw_cart') || '[]');
    var n = c.reduce(function(s, i) {{ return s + (i.qty || 1); }}, 0);
    var b = document.getElementById('cartBadge');
    if (b) {{ b.textContent = n; if (n > 0) b.classList.add('show'); }}
  }} catch (e) {{}}
}})();
</script>
'''

open(f'{VIEWS}/partials/header.ejs', 'w', encoding='utf-8').write(header_ejs)
open(f'{VIEWS}/partials/footer.ejs', 'w', encoding='utf-8').write(footer_ejs)
print('partials written: header.ejs, footer.ejs')

# ───────────────────────── 4. Per-page transforms ─────────────────────────
INC_HDR_LIVE = "<%- include('partials/header', {cartLive: true}) %>"
INC_HDR = "<%- include('partials/header', {cartLive: false}) %>"
INC_FTR = "<%- include('partials/footer') %>"
ONERR = ' onerror="this.onerror=null;this.src=\'/images/placeholder.svg\'"'

def common(html, depth=0):
    inc_h = INC_HDR.replace("partials/", "../partials/" * depth or "partials/") if depth else INC_HDR
    inc_f = INC_FTR.replace("partials/", "../partials/" * depth or "partials/") if depth else INC_FTR
    html = re.sub(r'<nav>.*?</nav>', inc_h, html, count=1, flags=re.DOTALL)
    html = re.sub(r'<footer>.*?</footer>', inc_f, html, count=1, flags=re.DOTALL)
    html = html.replace('info@scentworld.ca', 'hello@scentworld.ca')
    return html

written = []
def write_view(rel, content):
    path = f'{VIEWS}/{rel}.ejs'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w', encoding='utf-8').write(content)
    written.append(rel)

# --- simple stripped-header pages ---
SIMPLE = ['about', 'blog', 'terms', 'privacy-policy', 'shipping', 'refund']
for name in SIMPLE:
    h = open(f'{PUB}/{name}.html', encoding='utf-8').read()
    h = common(h)
    if name == 'blog':
        h = h.replace(' in 2025', '')
    write_view(name, h)

# --- blog posts (depth 1) ---
for name in os.listdir(f'{PUB}/blog'):
    if not name.endswith('.html'): continue
    h = open(f'{PUB}/blog/{name}', encoding='utf-8').read()
    h = re.sub(r'<nav>.*?</nav>', INC_HDR.replace("'partials/", "'../partials/"), h, count=1, flags=re.DOTALL)
    h = re.sub(r'<footer>.*?</footer>', INC_FTR.replace("'partials/", "'../partials/"), h, count=1, flags=re.DOTALL)
    h = h.replace('info@scentworld.ca', 'hello@scentworld.ca')
    if 'hotel-lobby' in name:
        h = h.replace(' in 2025', '')
    write_view(f'blog/{name[:-5]}', h)

# --- industries (depth 1) ---
for name in os.listdir(f'{PUB}/industries'):
    if not name.endswith('.html'): continue
    h = open(f'{PUB}/industries/{name}', encoding='utf-8').read()
    h = re.sub(r'<nav>.*?</nav>', INC_HDR.replace("'partials/", "'../partials/"), h, count=1, flags=re.DOTALL)
    h = re.sub(r'<footer>.*?</footer>', INC_FTR.replace("'partials/", "'../partials/"), h, count=1, flags=re.DOTALL)
    h = h.replace('info@scentworld.ca', 'hello@scentworld.ca')
    write_view(f'industries/{name[:-5]}', h)

# --- index.html ---
h = idx
h = re.sub(r'<nav id="nav">.*?</nav>', INC_HDR_LIVE, h, count=1, flags=re.DOTALL)
h = re.sub(r'<div class="mn" id="mn">.*?</div>\s*', '', h, count=1, flags=re.DOTALL)
h = re.sub(r'<footer>.*?</footer>', INC_FTR, h, count=1, flags=re.DOTALL)
h = h.replace("window.addEventListener('scroll', () => document.getElementById('nav').classList.toggle('sc', window.scrollY > 50));", '')
h = h.replace("document.getElementById('mbBtn').onclick = () => document.getElementById('mn').classList.add('op');", '')
h = h.replace("function cm() { document.getElementById('mn').classList.remove('op'); }", '')
h = h.replace('info@scentworld.ca', 'hello@scentworld.ca')
# image fallbacks on dynamic product templates
h = h.replace('<img src="${p.image_url}" alt="${pName}" class="pi-main">', '<img src="${p.image_url}" alt="${pName}" class="pi-main"' + ONERR + '>')
h = h.replace('<img src="${gallery[0]}" alt="${pName}" class="pi-hover">', '<img src="${gallery[0]}" alt="${pName}" class="pi-hover"' + ONERR + '>')
h = h.replace('<img src="${p.image_url}" alt="${pName}">', '<img src="${p.image_url}" alt="${pName}"' + ONERR + '>')
# mobile dead-space fixes
MOBILE_FIX = '''
/* ── Phase 1: mobile dead-space fixes ── */
@media(max-width:1024px){.sc2{height:260px}.sc2.lg{grid-row:auto;height:260px}}
@media(max-width:768px){
.hero{height:auto;min-height:100svh;padding:7rem 0 3.5rem}
.testi{padding:4rem 5vw}.testi::before,.testi::after{font-size:7rem}
.faq{padding:4rem 5vw}
.qb{padding:4rem 5vw}
.sc2{height:230px}.sc2.lg{height:230px}
.testi-grid{gap:1.2rem}
.booking-box{padding:2.2rem 1.4rem}
.spaces-head{padding-top:1rem}
}
'''
h = h.replace('</style>', MOBILE_FIX + '</style>', 1)
write_view('index', h)

# --- product.html ---
h = open(f'{PUB}/product.html', encoding='utf-8').read()
h = re.sub(r'<nav>.*?</nav>', INC_HDR_LIVE, h, count=1, flags=re.DOTALL)
h = re.sub(r'<footer>.*?</footer>', INC_FTR, h, count=1, flags=re.DOTALL)
h = h.replace('info@scentworld.ca', 'hello@scentworld.ca')
h = h.replace("document.getElementById('cartLinkBtn')", "document.getElementById('cartBtn')")
h = h.replace("""  const n = cart.reduce((s, i) => s + (i.qty||1), 0);
  const el = document.getElementById('cartCountNav');
  if (el) el.textContent = '(' + n + ')';""",
"""  const n = cart.reduce((s, i) => s + (i.qty||1), 0);
  const el = document.getElementById('cartBadge');
  if (el) { el.textContent = n; el.classList.toggle('show', n > 0); }""")
h = h.replace('.crumb{padding:1.5rem 4vw .5rem', '.crumb{padding:6.4rem 4vw .5rem')
# gallery image fallbacks
h = h.replace('<img src="${images[0]}" alt="${p.name}" id="mainImg" onclick="openZoom()">',
              '<img src="${images[0]}" alt="${p.name}" id="mainImg" onclick="openZoom()"' + ONERR + '>')
h = h.replace('<img src="${img}" alt="">', '<img src="${img}" alt=""' + ONERR + '>')
h = h.replace('<img src="${o.image_url}" alt="">', '<img src="${o.image_url}" alt=""' + ONERR + '>')
h = h.replace('<img src="${oil.image_url}" alt="">', '<img src="${oil.image_url}" alt=""' + ONERR + '>')
h = h.replace('<img src="${item.image_url}" alt="">', '<img src="${item.image_url}" alt=""' + ONERR + '>')
write_view('product', h)

# --- 404 + success (standalone → add header/footer) ---
for name in ('404', 'success'):
    h = open(f'{PUB}/{name}.html', encoding='utf-8').read()
    h = h.replace('info@scentworld.ca', 'hello@scentworld.ca')
    # body becomes block; wrap content in centered main
    h = re.sub(r'(<body[^>]*>)', r'\1\n' + INC_HDR + '\n<main style="min-height:72vh;display:flex;align-items:center;justify-content:center;padding:7.5rem 1.5rem 4rem">', h, count=1)
    h = h.replace('</body>', '</main>\n' + INC_FTR + '\n</body>')
    # neutralize body flex centering so header/footer flow correctly
    h = re.sub(r'body\{([^}]*)\}', lambda m: 'body{' + re.sub(r'display:flex;?|align-items:center;?|justify-content:center;?|min-height:100vh;?|flex-direction:column;?', '', m.group(1)) + '}', h, count=1)
    write_view(name, h)

print(f'views written: {len(written)} -> {sorted(written)}')

# ───────────────────────── 5. Move originals to legacy ─────────────────────────
os.makedirs(f'{LEGACY}/blog', exist_ok=True)
os.makedirs(f'{LEGACY}/industries', exist_ok=True)
moved = 0
for f in list(os.listdir(PUB)):
    if f.endswith('.html'):
        shutil.move(f'{PUB}/{f}', f'{LEGACY}/{f}'); moved += 1
for sub in ('blog', 'industries'):
    for f in list(os.listdir(f'{PUB}/{sub}')):
        if f.endswith('.html'):
            shutil.move(f'{PUB}/{sub}/{f}', f'{LEGACY}/{sub}/{f}'); moved += 1
print(f'moved {moved} html files to {LEGACY}/')
