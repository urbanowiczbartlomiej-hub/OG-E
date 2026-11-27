// site/privacy.mjs — renders the repo's PRIVACY.md into a standalone
// `privacy.html` for GitHub Pages.
//
// Why a separate page: the Chrome Web Store checks that the listing's privacy
// policy URL is reachable before it publishes, and it refused the GitHub
// "blob" view of PRIVACY.md ("Privacy policy link is not reachable", releases
// 1.75.0 and 1.75.1). A plain static HTML page on Pages is the robust target.
// PRIVACY.md stays the single source of truth; this only re-renders it.
//
// The renderer covers exactly the Markdown PRIVACY.md uses: `#`/`##`/`###`
// headings, paragraphs, `-` lists (with indented continuation lines),
// **bold**, *italic*, `code` and [links](url). Zero dependencies.

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline Markdown → HTML (escape first, then code spans, links, emphasis). @param {string} s */
const inline = (s) => {
  /** @type {string[]} */
  const codes = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c) => `@@CODE${codes.push(c) - 1}@@`);
  out = out
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return out.replace(/@@CODE(\d+)@@/g,(_, i) => `<code>${codes[Number(i)]}</code>`);
};

/**
 * @param {string} md PRIVACY.md source.
 * @returns {string} The full HTML document.
 */
export const renderPrivacyPage = (md) => {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  /** @type {string[]} */
  const html = [];
  /** @type {string[]} */
  let para = [];
  /** @type {string[] | null} */
  let list = null;
  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = null;
  };
  for (const line of lines) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      const n = h[1].length;
      html.push(`<h${n}>${inline(h[2])}</h${n}>`);
    } else if (/^\s*-\s+/.test(line)) {
      flushPara();
      if (!list) list = [];
      list.push(line.replace(/^\s*-\s+/, ''));
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else if (list && /^\s+/.test(line)) {
      list[list.length - 1] += ' ' + line.trim();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OG-E — Privacy</title>
<style>
  :root { --bg: #ffffff; --fg: #1d2330; --muted: #5b6575; --accent: #1f6fd1; --code: #eef1f5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d1117; --fg: #d6dbe3; --muted: #8b95a5; --accent: #4a9eff; --code: #1a2230; }
  }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, 'Segoe UI', Arial, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 28px; margin: 0 0 16px; }
  h2 { font-size: 20px; margin: 32px 0 8px; }
  h3 { font-size: 17px; margin: 24px 0 8px; }
  a { color: var(--accent); }
  code { background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; overflow-wrap: anywhere; }
  li { margin: 4px 0; }
  footer { margin-top: 48px; color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
<main>
${html.join('\n')}
<footer>OG-E · <a href="./">Features</a> · <a href="https://github.com/urbanowiczbartlomiej-hub/OG-E">Source on GitHub</a></footer>
</main>
</body>
</html>
`;
};
