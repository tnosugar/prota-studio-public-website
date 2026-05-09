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
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-database.js";

// Module-level state. Must be declared before init() runs since init()
// (called below) accesses state synchronously via closures.
const state = {
  comments: [],
  filter: "open",
  error: null,
};

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

  // 6. Subscribe to all comments and filter client-side. The dataset
  //    is small enough that client filtering is fine, and this removes
  //    the dependency on the database having .indexOn set on /comments/page
  //    (which would otherwise be required for the orderByChild query).
  console.log("[review-mode] page slug:", pageSlug);
  const commentsRef = ref(db, "comments");
  onValue(commentsRef, (snap) => {
    const data = snap.val() || {};
    const all = Object.entries(data).map(([id, val]) => ({ id, ...val }));
    state.comments = all.filter(c => c.page === pageSlug);
    console.log(`[review-mode] ${all.length} total comments, ${state.comments.length} on this page`);
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
  // Cross-page counters for elements inside nav/footer that don't have
  // a stable identifier (e.g. the social-icon list items). Same on every
  // page so the same N maps to the same element.
  const navCounters = {};
  const footerCounters = {};

  document.body.querySelectorAll(selector).forEach((el) => {
    if (el.closest(SKIP_SELECTOR)) return;
    if (el.hasAttribute("data-comment-id")) return;

    const isImgWrap = el.classList.contains("review-img-wrap");
    if (!isImgWrap) {
      const text = el.textContent.trim();
      if (text.length < 2) return;
    }

    let id = computeStableId(el, navCounters, footerCounters);
    if (!id) {
      const key = isImgWrap ? "img" : el.tagName.toLowerCase();
      counters[key] = (counters[key] || 0) + 1;
      id = `${pageSlug}-${key}-${counters[key]}`;
    }
    el.setAttribute("data-comment-id", id);
  });
}

// Stable cross-page anchor IDs for shared elements (nav, footer).
// Returns null if the element is not in a shared region — caller falls
// back to per-page sequence ID.
function computeStableId(el, navCounters, footerCounters) {
  if (el.closest("nav.top")) return computeNavId(el, navCounters);
  if (el.closest("footer.site")) return computeFooterId(el, footerCounters);
  return null;
}

function computeNavId(el, counters) {
  const tag = el.tagName.toLowerCase();
  // Logo link <a class="logo">
  if (tag === "a" && el.classList.contains("logo")) return "nav-logo";
  // Logo image (wrapped in .review-img-wrap)
  if (el.classList.contains("review-img-wrap") && el.closest(".logo")) return "nav-logo-img";
  // CTA button: <a class="cta">
  if (tag === "a" && el.classList.contains("cta")) {
    return `nav-cta-${slugifyHref(el.getAttribute("href"))}`;
  }
  // Regular nav link <a>
  if (tag === "a") {
    return `nav-link-${slugifyHref(el.getAttribute("href"))}`;
  }
  // <li> wrapping a link — anchor by the link's href
  if (tag === "li") {
    const a = el.querySelector("a");
    if (a) return `nav-item-${slugifyHref(a.getAttribute("href"))}`;
  }
  // Fallback — sequence within nav by tag (consistent across pages
  // because the nav HTML is identical)
  counters[tag] = (counters[tag] || 0) + 1;
  return `nav-${tag}-${counters[tag]}`;
}

function computeFooterId(el, counters) {
  const tag = el.tagName.toLowerCase();
  // Tagline paragraph
  if (tag === "p" && el.classList.contains("tagline")) return "footer-tagline";
  // Copyright block
  if (el.classList.contains("copyright")) return "footer-copyright";
  // Headings — slugify the text
  if (["h3", "h4"].includes(tag)) {
    return `footer-h-${slugifyText(el.textContent)}`;
  }
  // Footer links
  if (tag === "a") {
    return `footer-link-${slugifyHref(el.getAttribute("href"))}`;
  }
  // List items wrapping a link
  if (tag === "li") {
    const a = el.querySelector("a");
    if (a) return `footer-item-${slugifyHref(a.getAttribute("href"))}`;
  }
  // Fallback — sequence within footer by tag
  counters[tag] = (counters[tag] || 0) + 1;
  return `footer-${tag}-${counters[tag]}`;
}

function slugifyHref(href) {
  if (!href) return "none";
  // Strip protocol, leading/trailing slashes, replace non-word chars
  return href
    .replace(/^https?:\/\//, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "home";
}

function slugifyText(text) {
  return (text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
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
    const actions = renderActions(c.id, status);
    return `
      <div class="review-comment ${status}" data-comment="${c.id}" data-anchor="${escapeHtml(c.anchor || "")}">
        <div class="anchor">${escapeHtml(c.anchor || "(no anchor)")}</div>
        ${c.comment ? `<div class="text">${escapeHtml(c.comment)}</div>` : ""}
        ${c.replacement ? `<div class="replacement">${escapeHtml(c.replacement)}</div>` : ""}
        <div class="meta">
          <span class="status ${status}">${status}</span>
          <span>${when}</span>
        </div>
        <div class="actions">${actions}</div>
      </div>`;
  }).join("");

  // Click on the row body (anywhere except action buttons) scrolls to the anchor.
  listEl.querySelectorAll(".review-comment").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const anchor = row.getAttribute("data-anchor");
      const target = document.querySelector(`[data-comment-id="${cssEscape(anchor)}"]`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  // Action buttons: apply / dismiss / reopen.
  listEl.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = btn.getAttribute("data-action");
      const id = btn.getAttribute("data-comment");
      btn.disabled = true;
      try {
        await setStatus(id, action);
        toast(action === "open" ? "Reopened." : action.charAt(0).toUpperCase() + action.slice(1) + ".");
      } catch (err) {
        console.error("[review-mode] status update failed:", err);
        toast("Update failed: " + err.message);
        btn.disabled = false;
      }
    });
  });
}

function renderActions(id, status) {
  const apply = `<button data-comment="${id}" data-action="applied" class="apply-btn" title="Mark as applied">&#10004; Applied</button>`;
  const dismiss = `<button data-comment="${id}" data-action="dismissed" class="dismiss-btn" title="Dismiss">&#10005; Dismiss</button>`;
  const reopen = `<button data-comment="${id}" data-action="open" class="reopen-btn" title="Reopen">&#8634; Reopen</button>`;
  if (status === "applied") return reopen;
  if (status === "dismissed") return reopen;
  return apply + dismiss;
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
