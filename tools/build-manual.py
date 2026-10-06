#!/usr/bin/env python3
"""Builds manual.html (the page behind the "📖 คู่มือการใช้งาน" button) from คู่มือการใช้งาน.md.

Run from the project folder after editing the .md file:
    pip install markdown        # once
    python3 tools/build-manual.py
"""
import html, os, re, sys, unicodedata

try:
    import markdown
except ImportError:
    sys.exit("This needs the 'markdown' package:  pip install markdown")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'คู่มือการใช้งาน.md')
OUT = os.path.join(ROOT, 'manual.html')

LIST_ITEM = re.compile(r'^\s{0,3}(?:[-*+]|\d+[.)])\s+')

def fix_lists(text):
    """GitHub shows a list that directly follows a paragraph line; Python-Markdown needs a blank line first."""
    out, prev = [], ''
    in_fence = False
    for line in text.split('\n'):
        if line.strip().startswith('```'):
            in_fence = not in_fence
        if (not in_fence and LIST_ITEM.match(line) and prev.strip()
                and not LIST_ITEM.match(prev) and not prev.lstrip().startswith(('|', '#', '>'))
                and not prev.startswith((' ', '\t'))):
            out.append('')
        out.append(line)
        prev = line
    return '\n'.join(out)

def github_slug(text):
    """Same ids GitHub gives headings (keeps Thai letters and their vowel/tone marks), so the existing
    in-document table of contents links such as #4-คู่มือจอที่-2-การเชื่อมต่อ keep working."""
    text = re.sub(r'<[^>]+>', '', html.unescape(text)).strip().lower()
    kept = ''.join(ch for ch in text if unicodedata.category(ch)[0] in 'LMN' or ch in '_- ')
    return kept.replace(' ', '-')

def add_heading_ids(body):
    seen = {}
    def repl(m):
        level, inner = m.group(1), m.group(2)
        slug = github_slug(inner) or 'section'
        n = seen.get(slug, 0); seen[slug] = n + 1
        if n: slug = f'{slug}-{n}'
        return f'<h{level} id="{html.escape(slug, quote=True)}">{inner}</h{level}>'
    return re.sub(r'<h([1-4])>(.*?)</h\1>', repl, body, flags=re.S)

def finish(body):
    body = add_heading_ids(body)
    body = re.sub(r'<table>', '<div class="table-wrap"><table>', body)
    body = body.replace('</table>', '</table></div>')
    body = re.sub(r'<a href="(https?://[^"]+)"', r'<a href="\1" target="_blank" rel="noopener"', body)
    return body

TEMPLATE = '''<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>คู่มือการใช้งาน — Sri Karaoke</title>
<meta name="theme-color" content="#1B1533">
<link rel="icon" href="icons/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@500;600;700&family=Sarabun:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--ink:#1B1533;--panel:#241C42;--panel-2:#2E2552;--gold:#FFC857;--magenta:#FF3D81;--teal:#2EE6D6;--text:#F4F1FF;--text-dim:#B3ABD1;--line:#3A3162;}
:root[data-theme="light"]{--ink:#F4F2FA;--panel:#FFFFFF;--panel-2:#EFEBF7;--gold:#B8860B;--magenta:#D6266E;--teal:#0E8C82;--text:#241C42;--text-dim:#6E6690;--line:#DDD6EC;}
:root[data-theme="birthday"]{--ink:#2D0A3D;--panel:#4A1259;--panel-2:#5C1A6E;--gold:#FFD700;--magenta:#FF2E88;--teal:#00E5A0;--text:#FFF5FB;--text-dim:#E8B8DC;--line:#7A2E8C;}
:root[data-theme="newyear"]{--ink:#1A0F2E;--panel:#2D1B4E;--panel-2:#3D2563;--gold:#FFD700;--magenta:#E63946;--teal:#2EE6D6;--text:#FFF8E7;--text-dim:#D4C5E8;--line:#5C3D8C;}
:root[data-theme="songkran"]{--ink:#042A3D;--panel:#0A4A63;--panel-2:#0F5C7A;--gold:#FFD966;--magenta:#FF8FAB;--teal:#5FD4E8;--text:#F0FBFF;--text-dim:#A8D8E8;--line:#2A7A94;}
*{box-sizing:border-box;}
html{scroll-behavior:smooth;}
body{margin:0;background:var(--ink);color:var(--text);font-family:'Sarabun','Noto Sans Thai',system-ui,sans-serif;font-size:17px;line-height:1.75;-webkit-text-size-adjust:100%;}
.bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;padding:10px max(16px,env(safe-area-inset-right)) 10px max(16px,env(safe-area-inset-left));background:color-mix(in srgb,var(--ink) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);}
.bar img{width:34px;height:34px;border-radius:50%;}
.bar .t{flex:1;font-family:'Kanit',sans-serif;font-weight:600;font-size:17px;}
.bar .t span{color:var(--gold);}
.bar button{background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:999px;padding:8px 16px;font:600 14px 'Sarabun',sans-serif;cursor:pointer;}
.bar button:hover{border-color:var(--gold);}
main{max-width:880px;margin:0 auto;padding:24px 18px 90px;}
h1,h2,h3,h4{font-family:'Kanit',sans-serif;line-height:1.35;scroll-margin-top:70px;}
h1{font-size:clamp(26px,5vw,38px);margin:.4em 0 .3em;}
h2{font-size:clamp(22px,4vw,28px);margin:2em 0 .6em;padding-bottom:.3em;border-bottom:2px solid var(--line);color:var(--gold);}
h3{font-size:clamp(18px,3.4vw,22px);margin:1.7em 0 .5em;color:var(--teal);}
h4{font-size:18px;margin:1.4em 0 .4em;}
p{margin:.7em 0;}
a{color:var(--teal);}
strong{color:var(--text);font-weight:700;}
ul,ol{padding-left:1.4em;margin:.6em 0;}
li{margin:.3em 0;}
hr{border:none;border-top:1px solid var(--line);margin:2em 0;}
code{background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:.1em .4em;font-size:.9em;}
pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;}
pre code{background:none;border:none;padding:0;}
blockquote{margin:1em 0;padding:.2em 1em;border-left:4px solid var(--gold);background:var(--panel);border-radius:0 8px 8px 0;}
.table-wrap{overflow-x:auto;margin:1em 0;border:1px solid var(--line);border-radius:10px;}
table{border-collapse:collapse;width:100%;min-width:480px;}
th,td{padding:10px 14px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line);}
th{background:var(--panel-2);font-family:'Kanit',sans-serif;font-weight:600;white-space:nowrap;}
tr:last-child td{border-bottom:none;}
tbody tr:nth-child(even) td{background:color-mix(in srgb,var(--panel) 60%,transparent);}
.top{position:fixed;right:16px;bottom:18px;z-index:10;width:46px;height:46px;border-radius:50%;border:1px solid var(--line);background:var(--panel-2);color:var(--text);font-size:20px;cursor:pointer;display:none;box-shadow:0 6px 20px rgba(0,0,0,.35);}
@media print{.bar,.top{display:none;} body{background:#fff;color:#000;} h2{color:#000;} h3{color:#222;}}
</style>
</head>
<body>
<div class="bar">
  <img src="icons/icon-192.png" alt="">
  <div class="t">คู่มือการใช้งาน <span>Sri Karaoke</span></div>
  <button id="close-btn" type="button">✕ ปิดคู่มือ</button>
</div>
<main>
@@BODY@@
</main>
<button class="top" id="top-btn" type="button" aria-label="กลับขึ้นด้านบน">↑</button>
<script>
// Same colour theme as the app (stored by the settings page on this same site)
try{
  var t = localStorage.getItem('sriKaraoke_theme');
  if(['light','birthday','newyear','songkran'].indexOf(t) !== -1){
    document.documentElement.setAttribute('data-theme', t);
    var colors = { light:'#FFFFFF', birthday:'#4A1259', newyear:'#2D1B4E', songkran:'#0A4A63' };
    document.querySelector('meta[name="theme-color"]').setAttribute('content', colors[t]);
  }
}catch(e){}
// Opened in its own tab from the welcome screen: closing should return to the app
document.getElementById('close-btn').addEventListener('click', function(){
  window.close();
  setTimeout(function(){ if(history.length > 1) history.back(); else location.href = 'index.html'; }, 150);
});
var topBtn = document.getElementById('top-btn');
window.addEventListener('scroll', function(){ topBtn.style.display = window.scrollY > 600 ? 'block' : 'none'; }, { passive: true });
topBtn.addEventListener('click', function(){ window.scrollTo({ top: 0, behavior: 'smooth' }); });
</script>
</body>
</html>
'''

def main():
    with open(SRC, encoding='utf-8') as f:
        md_text = f.read()
    body = markdown.markdown(fix_lists(md_text), extensions=['tables', 'sane_lists', 'fenced_code'], output_format='html5')
    page = TEMPLATE.replace('@@BODY@@', finish(body))
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(page)
    print(f'wrote {os.path.relpath(OUT, ROOT)}  ({len(page):,} bytes)')

if __name__ == '__main__':
    main()
