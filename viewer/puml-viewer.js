/**
 * puml-viewer.js — PlantUML SVG 通用交互查看器（tushi 图示引擎）
 *
 * 用法 A（零文件接入，推荐）：
 *   /admin/diagrams/puml-viewer.html?src=foo.svg&notes=foo.notes.json&title=标题
 *
 * 用法 B（自定义壳页面内嵌）：
 *   <div data-puml="foo.svg" data-puml-notes="foo.notes.json" data-puml-title="标题"></div>
 *   <script src="/admin/diagrams/puml-viewer.js"><\/script>
 *
 * 用法 C（单文件交付，tushi 产物）：
 *   页面内嵌 <div id="pv-inline-svg">SVG源码<\/div>
 *        + <script type="application/json" id="pv-notes-data">notes JSON<\/script>
 *   再内联本引擎。零网络请求，单 HTML 文件可直接分享。
 *
 * notes JSON 格式（sidecar，与引擎解耦）：
 *   {
 *     "notes": [
 *       { "key": "cachePriceClass",            // 匹配 SVG <text> 文本
 *         "mode": "prefix",                    // exact|prefix|contains|regex，默认 prefix
 *         "title": "弹层标题",
 *         "body": "HTML 正文" }
 *     ]
 *   }
 *   多个锚点共享一条注释：用 "keys": ["a", "b"] 代替 "key"。
 *
 * 引擎不包含任何业务文案；SVG 尺寸从 viewBox 动态读取；notes 缺失时降级为纯浏览。
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  // ---------- 工具 ----------

  function qs(s, root) { return (root || document).querySelector(s); }
  function qsa(s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); }

  function parseQuery() {
    var q = {};
    location.search.replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var p = kv.split('=');
      q[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' '));
    });
    return q;
  }

  // 相对 src 以 viewer 自身位置为基准解析（viewer 和图同目录或子目录均可）
  function resolveUrl(src) {
    return new URL(src, document.baseURI).href;
  }

  // ---------- 匹配器（通用锚点匹配） ----------

  function makeMatcher(note) {
    var keys = note.keys || (note.key != null ? [note.key] : []);
    var mode = note.mode || 'prefix';
    if (mode === 'exact') {
      return function (t) { return keys.indexOf(t) !== -1; };
    }
    if (mode === 'contains') {
      return function (t) {
        for (var i = 0; i < keys.length; i++) if (t.indexOf(keys[i]) !== -1) return true;
        return false;
      };
    }
    if (mode === 'regex') {
      var res = keys.map(function (k) { return new RegExp(k); });
      return function (t) {
        for (var i = 0; i < res.length; i++) if (res[i].test(t)) return true;
        return false;
      };
    }
    // 默认 prefix：精确或前缀（参与者名在生命线/消息/底部会带后缀）
    return function (t) {
      for (var i = 0; i < keys.length; i++) if (t === keys[i] || t.indexOf(keys[i]) === 0) return true;
      return false;
    };
  }

  // ---------- 引擎主体 ----------

  function createViewer(host, opts) {
    var state = { svg: null, vbW: 0, vbH: 0, pop: null, notes: [], showZones: false };

    // ---- DOM 骨架（工具栏 + 画布） ----
    host.classList.add('pv-host');
    host.innerHTML =
      '<div class="pv-bar">' +
        '<div class="pv-title"></div>' +
        '<button class="pv-btn" data-act="zout" title="缩小">−</button>' +
        '<button class="pv-btn" data-act="zin" title="放大">＋</button>' +
        '<button class="pv-btn" data-act="fit" title="适应宽度">适应</button>' +
        '<button class="pv-btn" data-act="zones" title="显示所有可点击热区">高亮点位</button>' +
        '<div class="pv-sub"></div>' +
      '</div>' +
      '<div class="pv-stage"><div class="pv-svgwrap"><div class="pv-loading">加载架构图中…</div></div></div>';

    var bar = qs('.pv-bar', host), stage = qs('.pv-stage', host), wrap = qs('.pv-svgwrap', host);
    qs('.pv-title', host).textContent = opts.title || '';
    qs('.pv-sub', host).textContent = opts.notes ? '加载注释…' : '纯浏览模式（无注释文件）';

    // ---- 浮层 ----

    function closePop() {
      if (state.pop) { state.pop.remove(); state.pop = null; }
    }

    function showPop(anchorEl, note) {
      closePop();
      var p = document.createElement('div');
      p.className = 'pv-pop';
      p.innerHTML =
        '<div class="pv-pop-head"><div class="pv-pop-title"></div>' +
        '<button class="pv-pop-close">×</button></div>' +
        '<div class="pv-pop-body"></div>' +
        '<div class="pv-pop-tip">点空白处 / Esc 关闭</div>';
      qs('.pv-pop-title', p).textContent = note.title || '说明';
      qs('.pv-pop-body', p).innerHTML = note.body || '';
      document.body.appendChild(p);

      // JS 定位：锚点屏幕坐标 → 下方优先，越界翻转 + 夹紧
      var r = anchorEl.getBoundingClientRect();
      var pw = p.offsetWidth, ph = p.offsetHeight;
      var vw = window.innerWidth, vh = window.innerHeight;
      var left = Math.max(8, Math.min(r.left + r.width / 2 - pw / 2, vw - pw - 8));
      var top = r.bottom + 10;
      if (top + ph > vh - 8) top = r.top - ph - 10;
      if (top < 8) top = Math.max(8, Math.min(r.bottom + 10, vh - ph - 8));
      p.style.left = left + 'px';
      p.style.top = top + 'px';

      qs('.pv-pop-close', p).onclick = closePop;
      state.pop = p;
    }

    // ---- 热区绑定（通用：按 <text> 文本匹配 notes） ----

    function bindZones() {
      var matchers = state.notes.map(function (n) { return { m: makeMatcher(n), n: n }; });
      var count = 0;
      qsa('text', state.svg).forEach(function (el) {
        var t = (el.textContent || '').trim();
        if (!t) return;
        var hit = null;
        for (var i = 0; i < matchers.length; i++) {
          if (matchers[i].m(t)) { hit = matchers[i].n; break; }
        }
        if (!hit) return;
        count++;
        el.classList.add('pv-text');
        el.addEventListener('click', function (e) { e.stopPropagation(); showPop(el, hit); });
        try {
          var b = el.getBBox();
          if (b.width > 0 && b.height > 0) {
            var zone = document.createElementNS(NS, 'rect');
            zone.setAttribute('x', b.x - 4); zone.setAttribute('y', b.y - 4);
            zone.setAttribute('width', b.width + 8); zone.setAttribute('height', b.height + 8);
            zone.setAttribute('rx', 4);
            zone.classList.add('pv-zone');
            zone.addEventListener('click', function (e) { e.stopPropagation(); showPop(el, hit); });
            el.parentNode.insertBefore(zone, el);
          }
        } catch (e) { /* getBBox 不可用则只保留文本可点 */ }
      });
      qs('.pv-sub', host).textContent = state.notes.length
        ? '共 ' + count + ' 个可点击热区 · 点击图中元素查看说明'
        : '纯浏览模式（无注释文件）';
    }

    // ---- 缩放（直接改 svg 宽度，浮层坐标天然准确） ----

    function curW() { return parseFloat(state.svg.style.width) || state.vbW; }

    function setW(w) {
      if (!state.svg) return;
      w = Math.max(600, Math.min(state.vbW * 4, w));
      state.svg.style.width = w + 'px';
      closePop();
    }

    function fit() { setW(stage.clientWidth - 32); }

    // ---- 加载流程（svgText 直供 / src fetch 两种来源） ----

    function adoptSvg(txt) {
      wrap.innerHTML = txt;
      state.svg = qs('svg', wrap);
      if (!state.svg) throw new Error('内容中未找到 <svg>');
      state.svg.removeAttribute('width');
      state.svg.removeAttribute('height');
      var vb = (state.svg.getAttribute('viewBox') || '0 0 1200 800').trim().split(/\s+/);
      state.vbW = parseFloat(vb[2]) || 1200;
      state.vbH = parseFloat(vb[3]) || 800;
    }

    function adoptNotes(j) {
      if (j && Array.isArray(j.notes)) state.notes = j.notes;
      finish();
    }

    if (opts.svgText) {
      // 单文件/直供模式：SVG 与 notes 由页面内嵌，零网络请求
      try { adoptSvg(opts.svgText); } catch (e) {
        qs('.pv-loading', host) && (qs('.pv-loading', host).textContent = 'SVG 解析失败: ' + e.message);
        return;
      }
      if (opts.notesData) adoptNotes(opts.notesData);
      else finish();
    } else {
      fetch(resolveUrl(opts.src)).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (txt) {
        adoptSvg(txt);
        if (!opts.notes) { finish(); return; }
        // sidecar 注释可选：失败静默降级
        return fetch(resolveUrl(opts.notes)).then(function (r) {
          if (!r.ok) return null;
          return r.json();
        }).then(adoptNotes).catch(function () { finish(); });
      }).catch(function (e) {
        qs('.pv-loading', host) && (qs('.pv-loading', host).textContent = 'SVG 加载失败: ' + e.message);
      });
    }

    function finish() {
      if (state.notes.length) bindZones();
      else qs('.pv-sub', host).textContent = '纯浏览模式（无注释文件）';
      // 自由画布：按 SVG 原始宽度渲染，左右滚动，不压缩
      setW(state.vbW);
    }

    // ---- 工具栏事件 ----

    bar.addEventListener('click', function (e) {
      var btn = e.target.closest('.pv-btn');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'zin') setW(curW() * 1.25);
      else if (act === 'zout') setW(curW() / 1.25);
      else if (act === 'fit') fit();
      else if (act === 'zones') {
        state.showZones = !state.showZones;
        btn.classList.toggle('on', state.showZones);
        wrap.classList.toggle('pv-show', state.showZones);
      }
    });

    stage.addEventListener('scroll', closePop);
    return { closePop: closePop };
  }

  // ---------- 样式（一次性注入） ----------

  function injectStyle() {
    if (document.getElementById('pv-style')) return;
    var s = document.createElement('style');
    s.id = 'pv-style';
    s.textContent = [
      '.pv-host{display:flex;flex-direction:column;height:100vh;background:#111113;color:#d4d4d8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif}',
      '.pv-bar{position:sticky;top:0;z-index:50;background:rgba(17,17,19,.92);backdrop-filter:blur(8px);border-bottom:1px solid #27272a;padding:12px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
      '.pv-title{font-size:15px;color:#fafafa;font-weight:600;margin-right:auto}',
      '.pv-btn{border:1px solid #3f3f46;background:#27272a;color:#e4e4e7;border-radius:6px;height:28px;min-width:28px;padding:0 8px;cursor:pointer;font-size:13px;line-height:1;transition:all .15s}',
      '.pv-btn:hover{border-color:#f59e0b;color:#f59e0b}',
      '.pv-btn.on{border-color:#f59e0b;color:#f59e0b;background:rgba(245,158,11,.12)}',
      '.pv-sub{font-size:11.5px;color:#71717a;width:100%;margin-top:-4px}',
      '.pv-stage{flex:1;overflow:auto;padding:16px 20px}',
      '.pv-svgwrap{background:#FEFBF6;border:1px solid #27272a;border-radius:12px;margin:0 auto;position:relative}',
      '.pv-svgwrap svg{display:block;height:auto}',
      '.pv-loading{padding:80px 20px;text-align:center;color:#71717a;font-size:13px}',
      '.pv-zone{fill:transparent;cursor:pointer}',
      '.pv-show .pv-zone{fill:rgba(29,139,232,.08);stroke:#1d8be8;stroke-width:2;stroke-dasharray:6 4}',
      '.pv-text{cursor:pointer;transition:fill .1s}',
      '.pv-text:hover{fill:#1d8be8 !important}',
      '.pv-pop{position:fixed;z-index:100;background:#18181b;border:1px solid #3f3f46;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.65);max-width:420px;width:min(420px,calc(100vw - 24px));animation:pvIn .14s}',
      '@keyframes pvIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
      '.pv-pop-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:12px 14px 8px;border-bottom:1px solid #27272a}',
      '.pv-pop-title{font-size:13.5px;font-weight:600;color:#f59e0b;line-height:1.4}',
      '.pv-pop-close{background:none;border:none;color:#a1a1aa;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;flex-shrink:0}',
      '.pv-pop-close:hover{color:#fafafa}',
      '.pv-pop-body{padding:10px 14px 12px;font-size:12.5px;line-height:1.8;color:#d4d4d8}',
      '.pv-pop-body b{color:#fafafa;font-weight:600}',
      '.pv-pop-body code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;background:#27272a;border-radius:4px;padding:1px 5px;color:#fbbf24}',
      '.pv-pop-tip{padding:6px 14px 10px;font-size:11px;color:#52525b;border-top:1px solid #27272a}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ---------- 初始化 ----------

  function boot() {
    injectStyle();

    // 全局关闭（每个 viewer 共用一个浮层策略）
    document.addEventListener('click', function (e) {
      if (window.__pvPop && !e.target.closest('.pv-pop')) {
        window.__pvPop.closePop();
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && window.__pvPop) window.__pvPop.closePop();
    });
    window.addEventListener('resize', function () {
      if (window.__pvPop) window.__pvPop.closePop();
    });

    // 用法 C：单文件交付模式（tushi 产物）——页面内嵌 SVG + notes，零网络请求
    var inlineHost = qs('#pv-inline-svg');
    if (inlineHost) {
      var svgEl = qs('svg', inlineHost);
      if (svgEl) {
        var notesEl = qs('#pv-notes-data');
        var notesData = null;
        if (notesEl) {
          try { notesData = JSON.parse(notesEl.textContent); } catch (e) { notesData = null; }
        }
        var titleEl = qs('title');
        var svgText = inlineHost.innerHTML;
        inlineHost.style.display = '';   // 模板可能带 display:none，展示前清除
        window.__pvPop = createViewer(inlineHost, {
          svgText: svgText,
          notesData: notesData,
          title: (titleEl && titleEl.textContent) || '',
        });
        return;
      }
    }

    // 用法 A：URL 参数模式（puml-viewer.html?src=…&notes=…&title=…）
    var q = parseQuery();
    if (q.src) {
      var host = document.createElement('div');
      document.body.appendChild(host);
      window.__pvPop = createViewer(host, { src: q.src, notes: q.notes || '', title: q.title || '' });
      return;
    }

    // 用法 B：data-puml 属性模式
    qsa('[data-puml]').forEach(function (el) {
      window.__pvPop = createViewer(el, {
        src: el.getAttribute('data-puml'),
        notes: el.getAttribute('data-puml-notes') || '',
        title: el.getAttribute('data-puml-title') || '',
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
