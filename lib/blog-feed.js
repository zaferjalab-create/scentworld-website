// RSS 2.0 feed of the blog posts in views/blog/. Each post's title, summary
// and dates are read from its own <head> (og:title, meta description and the
// Article JSON-LD), once at startup, so a new post appears in the feed by
// existing — nothing to register.
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.scentworld.ca';
const DIR = path.join(__dirname, '..', 'views', 'blog');

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unescape = s => String(s).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

function readPosts() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.ejs')); } catch (e) { return []; }
  const posts = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    const pick = re => (src.match(re) || [])[1];
    const title = pick(/<meta property="og:title" content="([^"]+)"/) || pick(/<title>([^<|]+)/);
    const description = pick(/<meta name="description" content="([^"]+)"/);
    const published = pick(/"datePublished":\s*"([^"]+)"/);
    const modified = pick(/"dateModified":\s*"([^"]+)"/) || published;
    if (!title || !published) continue;
    posts.push({
      title: unescape(title.trim()),
      description: description ? unescape(description) : '',
      url: `${BASE}/blog/${f.replace(/\.ejs$/, '.html')}`,
      published, modified,
    });
  }
  return posts.sort((a, b) => b.published.localeCompare(a.published));
}

const POSTS = readPosts();

function rssDate(d) {
  // Dates in the posts are calendar days; publish them at noon Atlantic time.
  return new Date(`${d}T12:00:00-04:00`).toUTCString();
}

function feedXml() {
  const latest = POSTS.reduce((m, p) => (p.modified > m ? p.modified : m), '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Scent World Canada Blog</title>
  <link>${BASE}/blog.html</link>
  <description>Scent marketing, commercial fragrance and diffuser guides from Scent World Canada in Halifax, Nova Scotia.</description>
  <language>en-ca</language>
  <atom:link href="${BASE}/blog/feed.xml" rel="self" type="application/rss+xml"/>
${latest ? `  <lastBuildDate>${rssDate(latest)}</lastBuildDate>\n` : ''}${POSTS.map(p => `  <item>
    <title>${xml(p.title)}</title>
    <link>${p.url}</link>
    <guid isPermaLink="true">${p.url}</guid>
    <pubDate>${rssDate(p.published)}</pubDate>
    <description>${xml(p.description)}</description>
  </item>`).join('\n')}
</channel>
</rss>
`;
}

module.exports = { feedXml, POSTS };
