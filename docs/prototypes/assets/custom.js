// 把 typedoc/shiki 渲染的 <pre><code class="mermaid"><span>...</span><br/>... </code></pre>
// 还原成 mermaid 能解析的纯文本 <pre class="mermaid">text</pre>, 然后调 mermaid.run().
(function () {
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function extractText(code) {
    // shiki 用 <br/> 表示换行, <span> 分词。innerHTML 替换 br→\n, 再剥 tag, 再 unescape。
    var html = code.innerHTML
      .replace(/<br\s*\/?>(\s*\n)?/gi, "\n")
      .replace(/<\/?(span|code|pre)[^>]*>/gi, "");
    // unescape HTML 实体
    var ta = document.createElement("textarea");
    ta.innerHTML = html;
    return ta.value;
  }

  function transformBlocks() {
    var changed = 0;
    var nodes = document.querySelectorAll(
      'pre > code.mermaid, pre > code[class*="language-mermaid"]',
    );
    nodes.forEach(function (code) {
      var pre = code.closest("pre");
      if (!pre) return;
      var text = extractText(code);
      var holder = document.createElement("pre");
      holder.className = "mermaid";
      // mermaid.run 直接读 textContent
      holder.textContent = text;
      pre.replaceWith(holder);
      changed++;
    });
    return changed;
  }

  function init() {
    var n = transformBlocks();
    if (n === 0) return;
    loadScript("https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js")
      .then(function () {
        window.mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" });
        return window.mermaid.run({ querySelector: "pre.mermaid" });
      })
      .catch(function (e) {
        console.warn("mermaid load failed", e);
      });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(init, 0);
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();

// TypeDoc 自带搜索偏 API 符号索引；这里补充全文文档索引，支持中文说明和字段名检索。
(function () {
  var indexPromise = null;
  var renderSerial = 0;

  function getBasePath() {
    var base = document.documentElement.dataset.base || "./";
    return base.endsWith("/") ? base : base + "/";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      }[char];
    });
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalize(value) {
    return String(value || "").toLocaleLowerCase();
  }

  function tokenize(query) {
    var seen = Object.create(null);
    return query
      .trim()
      .split(/\s+/)
      .map(function (token) {
        return token.trim();
      })
      .filter(function (token) {
        var key = normalize(token);
        if (!key || seen[key]) return false;
        seen[key] = true;
        return true;
      })
      .slice(0, 8);
  }

  function isSearchableQuery(query) {
    return query.length >= 2 || /[\u3400-\u9fff]/u.test(query);
  }

  function scorePage(page, query, tokens) {
    var title = normalize(page.title);
    var text = normalize(page.text);
    var lowerQuery = normalize(query);
    var score = 0;
    var matchedTokens = 0;

    if (title.indexOf(lowerQuery) !== -1) score += 180;
    if (text.indexOf(lowerQuery) !== -1) score += 70;

    tokens.forEach(function (token) {
      var lowerToken = normalize(token);
      var inTitle = title.indexOf(lowerToken) !== -1;
      var inText = text.indexOf(lowerToken) !== -1;

      if (!inTitle && !inText) return;
      matchedTokens++;
      if (inTitle) score += 45;
      if (inText) score += 12;
    });

    if (tokens.length > 1 && matchedTokens < tokens.length) return 0;
    return score;
  }

  function findSnippetStart(text, query, tokens) {
    var lowerText = normalize(text);
    var lowerQuery = normalize(query);
    var exact = lowerText.indexOf(lowerQuery);
    if (exact !== -1) return exact;

    return tokens.reduce(function (best, token) {
      var index = lowerText.indexOf(normalize(token));
      if (index === -1) return best;
      return best === -1 || index < best ? index : best;
    }, -1);
  }

  function makeSnippet(text, query, tokens) {
    var startAt = findSnippetStart(text, query, tokens);
    if (startAt === -1) return text.slice(0, 180) + (text.length > 180 ? " ..." : "");

    var start = Math.max(0, startAt - 70);
    var end = Math.min(text.length, startAt + Math.max(query.length, 24) + 110);
    return (start > 0 ? "... " : "") + text.slice(start, end).trim() + (end < text.length ? " ..." : "");
  }

  function highlight(value, query, tokens) {
    var seen = Object.create(null);
    var terms = [query].concat(tokens)
      .map(function (term) {
        return term.trim();
      })
      .filter(function (term) {
        var key = normalize(term);
        if (!key || seen[key]) return false;
        seen[key] = true;
        return true;
      })
      .sort(function (a, b) {
        return b.length - a.length;
      });

    if (!terms.length) return escapeHtml(value);

    var pattern = new RegExp(terms.map(escapeRegExp).join("|"), "gi");
    var output = "";
    var lastIndex = 0;
    var match;

    while ((match = pattern.exec(value)) !== null) {
      output += escapeHtml(value.slice(lastIndex, match.index));
      output += "<mark>" + escapeHtml(match[0]) + "</mark>";
      lastIndex = match.index + match[0].length;
    }

    return output + escapeHtml(value.slice(lastIndex));
  }

  function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetch(getBasePath() + "assets/doc-search-index.json", { cache: "no-store" })
        .then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        })
        .then(function (data) {
          return Array.isArray(data.pages) ? data.pages : [];
        });
    }

    return indexPromise;
  }

  function renderResults(resultsEl, statusEl, query, pages) {
    var tokens = tokenize(query);
    var matches = pages
      .map(function (page) {
        return {
          page: page,
          score: scorePage(page, query, tokens),
        };
      })
      .filter(function (entry) {
        return entry.score > 0;
      })
      .sort(function (a, b) {
        return b.score - a.score || a.page.title.localeCompare(b.page.title, "zh-Hans-CN");
      })
      .slice(0, 12);

    resultsEl.innerHTML = "";
    statusEl.innerHTML = "";

    if (!matches.length) {
      statusEl.innerHTML = "<div>没有找到 “<strong>" + escapeHtml(query) + "</strong>”。</div>";
      return;
    }

    var base = getBasePath();
    matches.forEach(function (entry, index) {
      var page = entry.page;
      var li = document.createElement("li");
      var link = document.createElement("a");

      li.id = "doc-search:" + renderSerial + "-" + index;
      li.role = "option";
      li.ariaSelected = "false";
      li.className = "doc-search-result";

      link.tabIndex = -1;
      link.href = base + page.url;
      link.innerHTML =
        '<span class="doc-search-title">' + highlight(page.title, query, tokens) + "</span>" +
        '<span class="doc-search-snippet">' + highlight(makeSnippet(page.text, query, tokens), query, tokens) + "</span>";

      li.appendChild(link);
      resultsEl.appendChild(li);
    });
  }

  function initSearch() {
    var trigger = document.getElementById("tsd-search-trigger");
    var input = document.getElementById("tsd-search-input");
    var results = document.getElementById("tsd-search-results");
    var status = document.getElementById("tsd-search-status");

    if (!trigger || !input || !results || !status) return;

    input.placeholder = "搜索文档和字段";

    function requestRender() {
      var query = input.value.trim();
      var serial = ++renderSerial;

      input.setAttribute("aria-activedescendant", "");

      if (!isSearchableQuery(query)) {
        results.innerHTML = "";
        status.innerHTML = query ? "<div>请至少输入 2 个字符。</div>" : "<div>输入字段名或中文关键字搜索全文文档。</div>";
        return;
      }

      status.innerHTML = "<div>正在搜索 “<strong>" + escapeHtml(query) + "</strong>”...</div>";

      loadIndex()
        .then(function (pages) {
          if (serial !== renderSerial || input.value.trim() !== query) return;
          renderResults(results, status, query, pages);
        })
        .catch(function (error) {
          if (serial !== renderSerial) return;
          results.innerHTML = "";
          status.innerHTML = "<div>全文搜索索引加载失败。</div>";
          console.warn("doc search index load failed", error);
        });
    }

    input.addEventListener("input", function (event) {
      event.stopImmediatePropagation();
      requestRender();
    }, true);

    input.addEventListener("focus", requestRender);
    trigger.addEventListener("click", function () {
      setTimeout(requestRender, 0);
    });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(initSearch, 0);
  } else {
    document.addEventListener("DOMContentLoaded", initSearch);
  }
})();
