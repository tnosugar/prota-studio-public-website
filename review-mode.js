// review-mode.js
//
// Live-site review widget for protastudios.ai.
//
// Activated by ?review=1. Auto-anchors data-comment-id to every
// content element (h1-h4, p, li inside <main>/<section>). Hover-to-pill,
// click-to-comment. Comments stored at /comments/{push-id} in the same
// Firebase RTDB the contact form uses.
//
// Visibility: Vernon (or any reviewer at the URL) sees a sidebar drawer
// listing all comments for the current page, with status (open / applied
// / dismissed). On the public site (no ?review=1), the widget is inert.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  onValue,
  update,
  query,
  orderByChild,
  equalTo,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-database.js";

const cfg = window.PROTA_CONTACT_CONFIG;
if (!cfg || !cfg.FIREBASE_CONFIG) {
  console.error("[review-mode] missing PROTA_CONTACT_CONFIG.FIREBASE_CONFIG");
} else {
  init();
}

function init() {
  const app = initializeApp(cfg.FIREBASE_CONFIG, "review-mode");
  const db = getDatabase(app);

  document.documentElement.setAttribute("data-review-mode", "on");

  // 1. Compute page slug from pathname.
  // /                    → "home"
  // /about/              → "about"
  // /work/citi-ventures/ → "work-citi-ventures"
  const pageSlug = computePageSlug(window.location.pathname);

  // 2. Auto-assign data-comment-id to every annotatable element.
  // Stable IDs: {pageSlug}-{tag}-{n} where n is sequence within the
  // page's content area. Survives small text edits but not reorders.
  assignAnchors(pageSlug);

  // 3. Render banner.
  renderBanner();

  // 4. Render sidebar shell.
  const sidebar = renderSidebar();
  document.body.appendChild(sidebar);

  // 5. Wire each annotatable element with a hover pill.
  wireAnchors();

  // 6. Subscribe to comments for this page.
  const commentsRef = query(ref(db, "comments"), orderByChild("page"), equalTo(pageSlug));
  onValue(commentsRef, (snap) => {
    const data = snap.val() || {};
    state.comments = Object.entries(data).map(([id, val]) => ({ id, ...val }));
    renderCommentList();
    decorateAnchors();
  }, (err) => {
    console.error("[review-mode] read failed:", err);
    state.error = err.message;
    renderCommentList();
  });

  // Expose helpers for debugging
  window.__review = { state, db };
}

const state = {
  comments: [],
  filter: "open",
  error: null,
};

// =================================================================
// Anchor assignment
// =================================================================

function computePageSlug(pathname) {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "home";
  return trimmed.replace(/\//g, "-");
}

function assignAnchors(pageSlug) {
  // Annotate every meaningful content element on the page so Vernon can
  // comment on anything visible — including buttons, nav links, footer
  // links, labels, icons, and images. Skips only the widget itself,
  // form inputs (which Vernon shouldn't comment on the form fields,
  // only on the labels around them), and explicit opt-outs.
  const SKIP_SELECTOR = ".review-banner, .review-sidebar, .review-sidebar-toggle, .review-modal-backdrop, .review-pill, [data-review-skip], input, textarea, select, option, script, style";

  // Step 1: wrap each <img> in a relatively-positioned span so the pill
  // can anchor next to the image. Skips images already inside the
  // widget itself.
  document.querySelectorAll("img").forEach((img) => {
    if (img.closest(SKIP_SELECTOR)) return;
    if (img.parentElement && img.parentElement.classList.contains("review-img-wrap")) return;
    const wrap = document.createElement("span");
    wrap.className = "review-img-wrap";
    wrap.style.cssText = "display: inline-block; position: relative; line-height: 0; max-width: 100%;";
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);
  });

  // Step 2: collect annotatable elements
  const TAGS = ["h1","h2","h3","h4","h5","h6","p","li","summary","a","button","label","blockquote","figcaption","details"];
  const SPAN_SELECTORS = ["span.eyebrow","span.chip","span.lede","span.muted","span.tagline","span.role","span.section","span.copyright"];
  const selector = TAGS.join(",") + "," + SPAN_SELECTORS.join(",") + ",.review-img-wrap";

  const counters = {};
  document.body.querySelectorAll(selector).forEach((el) => {
    if (el.closest(SKIP_SELECTOR)) return;
    if (el.hasAttribute("data-comment-id")) return;

    // For non-image elements, require some text content
    const isImgWrap = el.classList.contains("review-img-wrap");
    if (!isImgWrap) {
      const text = el.textContent.trim();
      if (text.length < 2) return;
    }

    const key = isImgWrap ? "img" : el.tagName.toLowerCase();
    counters[key] = (counters[key] || 0) + 1;
    const id = `${pageSlug}-${key}-${counters[key]}`;
    el.setAttribute("data-comment-id", id);
  });
}

function wireAnchors() {
  const all = document.body.querySelectorAll("[data-comment-id]");
  all.forEach((el) => {
    // Pill (only created on first hover; lazy)
    el.addEventListener("mouseenter", () => {
      if (!el.querySelector(".review-pill")) {
        const pill = document.createElement("button");
        pill.className = "review-pill";
        pill.type = "button";
        pill.textContent = "+";
        pill.title = "Add a comment on this element";
        pill.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openModal(el);
        });
        el.appendChild(pill);
        // Pill visibility for elements that already have comments
        decoratePill(el, pill);
      }
    });
  });
}

function decorateAnchors() {
  document.querySelectorAll("[data-comment-id]").forEach((el) => {
    const id = el.getAttribute("data-comment-id");
    const my = state.comments.filter((c) => c.anchor === id);
    el.classList.remove("has-comment", "has-applied-comment");
    if (my.some((c) => c.status === "open")) el.classList.add("has-comment");
    else if (my.length && my.every((c) => c.status === "applied")) el.classList.add("has-applied-comment");
    const pill = el.querySelector(".review-pill");
    if (pill) decoratePill(el, pill);
  });
}

function decoratePill(el, pill) {
  const id = el.getAttribute("data-comment-id");
  const my = state.comments.filter((c) => c.anchor === id);
  pill.classList.remove("has-comment", "has-applied-comment");
  if (my.some((c) => c.status === "open")) pill.classList.add("has-comment");
  else if (my.length && my.every((c) => c.status === "applied")) pill.classList.add("has-applied-comment");
}

// =================================================================
// Modal
// =================================================================

function openModal(el) {
  const id = el.getAttribute("data-comment-id");
  const preview = el.textContent.trim().slice(0, 200);

  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal" role="dialog">
      <h3>Leave a comment</h3>
      <div class="anchor-info">${escapeHtml(id)}</div>
      <div class="anchor-preview">"${escapeHtml(preview)}${preview.length === 200 ? "…" : ""}"</div>
      <label>Comment <span class="opt">(what to change, why)</span></label>
      <textarea name="comment" rows="3" placeholder="Tighten this, drop the second clause…" autofocus></textarea>
      <label>Suggested replacement <span class="opt">(optional — verbatim copy if you have it)</span></label>
      <textarea name="replacement" rows="4" placeholder="(optional) the exact rewrite…"></textarea>
      <div class="error" style="display:none"></div>
      <div class="actions">
        <button type="button" class="secondary" data-cancel>Cancel</button>
        <button type="button" class="primary" data-submit>Save comment</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("[data-cancel]").addEventListener("click", close);
  backdrop.querySelector("[data-submit]").addEventListener("click", async () => {
    const comment = backdrop.querySelector('textarea[name="comment"]').value.trim();
    const replacement = backdrop.querySelector('textarea[name="replacement"]').value.trim();
    const errEl = backdrop.querySelector(".error");
    if (!comment && !replacement) {
      errEl.textContent = "Either a comment or a replacement is required.";
      errEl.style.display = "block";
      return;
    }
    try {
      await submitComment({
        page: computePageSlug(window.location.pathname),
        anchor: id,
        comment,
        replacement,
        text_preview: preview.slice(0, 280),
        url: window.location.href,
      });
      close();
      toast("Saved.");
      // Highlight the sidebar so Vernon sees it landed
      const sb = document.querySelector(".review-sidebar");
      if (sb) {
        sb.classList.add("open");
        setTimeout(() => {
          const list = sb.querySelector("[data-list]");
          if (list) list.scrollTop = 0;
        }, 200);
      }
    } catch (err) {
      errEl.textContent = "Save failed: " + err.message;
      errEl.style.display = "block";
    }
  });
  document.addEventListener("keydown", function escHandler(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", escHandler);
    }
  });
}

async function submitComment(data) {
  const app = initializeApp(cfg.FIREBASE_CONFIG, "review-mode-write");
  const db = getDatabase(app);
  const commentsRef = ref(db, "comments");
  const newRef = push(commentsRef);
  await update(newRef, {
    page: data.page,
    anchor: data.anchor,
    comment: data.comment || "",
    replacement: data.replacement || "",
    text_preview: data.text_preview,
    url: data.url,
    status: "open",
    user_agent: navigator.userAgent.slice(0, 200),
    timestamp: Date.now(),
  });
}

async function setStatus(commentId, status, extra) {
  const app = initializeApp(cfg.FIREBASE_CONFIG, "review-mode-write");
  const db = getDatabase(app);
  const cRef = ref(db, "comments/" + commentId);
  await update(cRef, Object.assign({ status, status_at: Date.now() }, extra || {}));
}

// =================================================================
// Banner + Sidebar
// =================================================================

function renderBanner() {
  const banner = document.createElement("div");
  banner.className = "review-banner";
  banner.innerHTML = `
    <div><span class="dot"></span> Review mode &middot; click any paragraph or heading to leave a comment</div>
    <div><a href="${window.location.pathname}">Exit</a></div>`;
  document.body.appendChild(banner);
}

function renderSidebar() {
  const sb = document.createElement("aside");
  sb.className = "review-sidebar";
  sb.innerHTML = `
    <header>
      <span>Comments on this page</span>
      <span class="count" data-count>0</span>
    </header>
    <div class="filter-row">
      <button data-filter="open" class="active">Open</button>
      <button data-filter="applied">Applied</button>
      <button data-filter="dismissed">Dismissed</button>
      <button data-filter="all">All</button>
    </div>
    <div class="comments" data-list>
      <div class="empty">No comments yet. Hover any element and click "+".</div>
    </div>`;

  // Sidebar toggle for narrow screens
  const toggle = document.createElement("button");
  toggle.className = "review-sidebar-toggle";
  toggle.textContent = "Comments";
  toggle.addEventListener("click", () => {
    sb.classList.toggle("open");
  });
  document.body.appendChild(toggle);

  sb.querySelectorAll(".filter-row button").forEach((b) => {
    b.addEventListener("click", () => {
      sb.querySelectorAll(".filter-row button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.filter = b.dataset.filter;
      renderCommentList();
    });
  });

  return sb;
}

function renderCommentList() {
  const sb = document.querySelector(".review-sidebar");
  if (!sb) return;
  const listEl = sb.querySelector("[data-list]");
  const countEl = sb.querySelector("[data-count]");
  const filtered = state.comments
    .filter((c) => state.filter === "all" ? true : (c.status || "open") === state.filter)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  countEl.textContent = state.comments.length;

  if (state.error) {
    listEl.innerHTML = `<div class="empty" style="color:#dc2626;">Database read error: ${escapeHtml(state.error)}<br/><br/><span style="font-size:11px;">Likely missing read rule on /comments. See Firebase rules doc.</span></div>`;
    return;
  }

  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty">No ${state.filter} comments.</div>`;
    return;
  }

  listEl.innerHTML = filtered.map((c) => {
    const status = c.status || "open";
    const when = c.timestamp ? new Date(c.timestamp).toLocaleString() : "";
    return `
      <div class="review-comment ${status}" data-comment="${c.id}" data-anchor="${escapeHtml(c.anchor || "")}">
        <div class="anchor">${escapeHtml(c.anchor || "(no anchor)")}</div>
        ${c.comment ? `<div class="text">${escapeHtml(c.comment)}</div>` : ""}
        ${c.replacement ? `<div class="replacement">${escapeHtml(c.replacement)}</div>` : ""}
        <div class="meta">
          <span class="status ${status}">${status}</span>
          <span>${when}</span>
        </div>
      </div>`;
  }).join("");

  listEl.querySelectorAll(".review-comment").forEach((row) => {
    row.addEventListener("click", () => {
      const anchor = row.getAttribute("data-anchor");
      const target = document.querySelector(`[data-comment-id="${cssEscape(anchor)}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  });
}

// =================================================================
// Helpers
// =================================================================

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str || "");
  return div.innerHTML;
}

function cssEscape(s) {
  return (window.CSS && window.CSS.escape) ? window.CSS.escape(s) : String(s).replace(/[^\w-]/g, "\\$&");
}

function toast(text) {
  const t = document.createElement("div");
  t.className = "review-toast";
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
