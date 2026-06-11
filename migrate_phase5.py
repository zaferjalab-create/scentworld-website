# Phase 5 migration: localize Unsplash images, lazy-load below-fold images,
# add breadcrumbs + BreadcrumbList schema to industry & blog pages.
import sys, re, glob, os
sys.stdout.reconfigure(encoding='utf-8')

BASE = 'https://www.scentworld.ca'
ROOT = os.path.dirname(os.path.abspath(__file__))
UNSPLASH = re.compile(r'https://images\.unsplash\.com/(photo-[0-9a-z-]+)\?[^"\']*')

views = glob.glob(os.path.join(ROOT, 'views', '**', '*.ejs'), recursive=True)

# ── 1. Replace Unsplash hotlinks with local copies ──────────────
for path in views:
    with open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')
    changed = 0
    for i, line in enumerate(lines):
        if 'images.unsplash.com' not in line:
            continue
        absolute = ('og:image' in line) or ('"image"' in line) or ("'image'" in line) or ('twitter:image' in line)
        repl = (BASE if absolute else '') + r'/images/stock/\1.webp'
        lines[i] = UNSPLASH.sub(repl, line)
        changed += 1
    if changed:
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write('\n'.join(lines))
        print(f'localized {changed:2d} image refs in {os.path.relpath(path, ROOT)}')

# ── 2. Lazy-load below-fold local stock images ──────────────────
LAZY_FILES = ['views/index.ejs', 'views/blog.ejs', 'views/about.ejs',
              'views/industries/index.ejs', 'views/industries/hotels.ejs',
              'views/industries/spas.ejs', 'views/industries/restaurants.ejs']
for rel in LAZY_FILES:
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        continue
    with open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')
    changed = 0
    for i, line in enumerate(lines):
        if '<img' in line and '/images/stock/' in line and 'loading=' not in line and 'hero' not in line:
            lines[i] = line.replace('<img ', '<img loading="lazy" decoding="async" ')
            changed += 1
    if changed:
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write('\n'.join(lines))
        print(f'lazy-loaded {changed} imgs in {rel}')

# ── 3. Breadcrumbs on industry + blog pages ─────────────────────
CRUMB_CSS = '<style>.crumb5{padding:6.2rem 4vw .2rem;font-size:.7rem;letter-spacing:.06em;color:#958e85;position:relative;z-index:5}.crumb5 a{color:#958e85;text-decoration:none;transition:color .3s}.crumb5 a:hover{color:#c9a55c}.crumb5 span{margin:0 .5rem;color:#635d55}</style>'

def page_meta(path):
    rel = os.path.relpath(path, os.path.join(ROOT, 'views')).replace('\\', '/')
    with open(path, encoding='utf-8') as f:
        content = f.read()
    m = re.search(r'<title>([^<|]+)', content)
    title = m.group(1).strip() if m else 'Page'
    if rel == 'industries/index.ejs':
        return content, [('Home', '/'), ('Industries', None)]
    if rel.startswith('industries/'):
        name = title.replace(' Scent Marketing Canada', '').replace(' | Scent World Canada', '').strip()
        url = '/industries/' + os.path.basename(rel).replace('.ejs', '.html')
        return content, [('Home', '/'), ('Industries', '/industries/'), (name, None)]
    if rel == 'blog.ejs':
        return content, [('Home', '/'), ('Blog', None)]
    if rel.startswith('blog/'):
        return content, [('Home', '/'), ('Blog', '/blog.html'), (title, None)]
    return content, None

CRUMB_TARGETS = (glob.glob(os.path.join(ROOT, 'views', 'industries', '*.ejs')) +
                 glob.glob(os.path.join(ROOT, 'views', 'blog', '*.ejs')) +
                 [os.path.join(ROOT, 'views', 'blog.ejs')])

for path in CRUMB_TARGETS:
    content, trail = page_meta(path)
    if not trail or 'crumb5' in content:
        continue
    rel = os.path.relpath(path, os.path.join(ROOT, 'views')).replace('\\', '/')
    # page URL for the last schema item
    if rel == 'industries/index.ejs': page_url = '/industries/'
    elif rel == 'blog.ejs': page_url = '/blog.html'
    elif rel.startswith('industries/'): page_url = '/industries/' + os.path.basename(rel).replace('.ejs', '.html')
    else: page_url = '/blog/' + os.path.basename(rel).replace('.ejs', '.html')

    items = []
    for pos, (name, url) in enumerate(trail, 1):
        item_url = BASE + (url if url else page_url)
        items.append(f'{{"@type":"ListItem","position":{pos},"name":{name!r},"item":"{item_url}"}}'.replace("'", '"').replace('"""', '"'))
    # safe JSON building
    import json
    items = [json.dumps({"@type": "ListItem", "position": pos, "name": name,
                         "item": BASE + (url if url else page_url)})
             for pos, (name, url) in enumerate(trail, 1)]
    schema = ('<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":['
              + ','.join(items) + ']}</script>')

    crumb_html = '<div class="crumb5">' + '<span>&rsaquo;</span>'.join(
        (f'<a href="{url}">{name}</a>' if url else name) for name, url in trail) + '</div>'

    new = content.replace('</head>', CRUMB_CSS + '\n' + schema + '\n</head>', 1)
    new = re.sub(r"(<%- include\('\.\./partials/header'[^%]*%>|<%- include\('partials/header'[^%]*%>)",
                 r'\1\n' + crumb_html, new, count=1)
    if new != content:
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(new)
        print(f'breadcrumbs added to {rel}')

print('done')
