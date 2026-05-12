// review-mode.js
//
// Live-site review widget za odvaz public surfaces (počevši sa /susreti/).
//
// Activated by ?review=1. Auto-anchors data-comment-id to every
// content element (h1-h4, p, li inside <main>/<section>). Hover-to-pill,
// click-to-comment. Comments stored at /comments/{push-id} in Firebase RTDB.
//
// Visibility: bilo koji reviewer na URL-u sa flagom vidi sidebar drawer
// sa listom komentara za trenutnu stranu, sa status workflow-om (open /
// applied / dismissed / reopen). Na javnoj stranici (bez ?review=1),
// widget je inertan.

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
  filter: "active", // "active" | "applied" | "archived"
  error: null,
};

// ---------- Comment lifecycle helpers (shared) ----------
// Comment shape u Firebase RTDB:
//   /comments/{push-id}
//     page, anchor, comment, replacement, text_preview, url, timestamp,
//     user_agent
//     status:  'pending' | 'applied' | 'archived'  — canonical enum
//     applied_at:  number  — timestamp transitioned to applied
//     archived_at: number  — timestamp transitioned to archived
//     edited_at:   number  — timestamp last edited
//
// Reader-side shim: legacy records carry boolean `archived: true|false`
// (pre-2026-05-12b) or `status: 'applied'|'dismissed'` (pre-shim). The
// getStatus() helper normalizes all reads to the enum. Per
// library/features/review-widget/comment-lifecycle.md §"Schema" and
// §"Backward compatibility — reader-side shim". New writes use the
// enum directly; the shim runs forever (or until a separate migration
// pass walks /comments/ and rewrites every record — prota: done
// 2026-05-13).
function getStatus(c) {
  if (c.status === "pending" || c.status === "applied" || c.status === "archived") return c.status;
  if (c.archived === true) return "archived";
  if (c.applied === true) return "applied";
  if (c.status === "applied") return "applied";   // legacy enum value
  if (c.status === "dismissed") return "archived"; // legacy enum value
  return "pending";
}
function isPending(c)  { return getStatus(c) === "pending"; }
function isApplied(c)  { return getStatus(c) === "applied"; }
function isArchived(c) { return getStatus(c) === "archived"; }

// ---------- Labels (localizable via cfg.REVIEW_LABELS) ----------
// English defaults. Projects override via window.{CONFIG}.REVIEW_LABELS:
//   window.PROTA_CONTACT_CONFIG = {
//     FIREBASE_CONFIG: {...},
//     REVIEW_LABELS: {
//       activeTab: "Aktivni",
//       archiveTab: "Arhiva",
//       commentsCount: { one: "{n} komentar", few: "{n} komentara", other: "{n} komentara" },
//       locale: "sr",
//       // ...override any keys; unspecified ones fall back to English.
//     }
//   };
// `locale` controls Intl.PluralRules form selection. `commentsCount`
// (and any future plural-aware string) uses the locale's plural categories
// (e.g. en: "one"/"other"; sr: "one"/"few"/"other").
const DEFAULT_LABELS = {
  locale: "en",
  // Pill / element interaction
  addCommentTitle: "Add comment to this element",
  // Banner
  bannerText: "Review mode",
  bannerHint: "click any element to leave a comment",
  bannerClose: "Close",
  // Sidebar header + filter tabs
  sidebarTitle: "Comments on this page",
  activeTab: "Active",
  appliedTab: "Applied",
  archiveTab: "Archive",
  // Empty states
  noCommentsYet: 'No comments yet. Hover over any element and click "+".',
  emptyArchive: 'Archive is empty. Comments are archived when you click "Mark as done".',
  noActiveComments: 'No active comments yet. Hover over any element and click "+".',
  // DB error
  dbReadErrorPrefix: "Error reading database: ",
  dbReadErrorHint: "Likely missing a read rule on /comments. Check Firebase rules.",
  // Modal
  modalTitleNew: "New comment",
  modalTitleEdit: "Edit comment",
  modalSubmitNew: "Save comment",
  modalSubmitEdit: "Save changes",
  modalCancel: "Cancel",
  modalCommentLabel: "Comment",
  modalCommentHint: "(what to change, why)",
  modalCommentPlaceholder: "Shorten this, drop the second sentence…",
  modalReplacementLabel: "Replacement suggestion",
  modalReplacementHint: "(optional — verbatim text if you have it)",
  modalReplacementPlaceholder: "(optional) exact replacement text…",
  modalRequiredError: "Comment or replacement suggestion is required.",
  // Toggle button
  toggleButton: "Comments",
  toggleButtonTitle: "Open comment review mode",
  // Group status badges
  statusPending: "Pending",
  statusApplied: "Applied",
  statusDone: "Done",  // legacy alias for statusApplied; kept for back-compat
  // Comment row meta
  editedPrefix: "edited",
  noAnchorFallback: "(no anchor)",
  // Action buttons
  applyLabel: "Apply",
  applyTitle: "Apply this comment (mark as acted on)",
  editLabel: "Edit",
  editTitle: "Edit comment",
  archiveLabel: "Archive",
  archiveTitle: "Archive comment",
  restoreLabel: "Restore",
  restoreTitle: "Restore to pending",
  deleteLabel: "Delete",
  deleteTitle: "Delete comment",
  // Toast / confirm
  saved: "Saved.",
  applied: "Applied.",
  archived: "Archived.",
  deleted: "Deleted.",
  restoredToPending: "Restored to pending.",
  restoredToActive: "Restored to pending.",  // legacy alias kept for back-compat
  errorPrefix: "Error: ",
  elementGone: "Element no longer exists on the page.",
  confirmDelete: "Delete comment permanently?",
  // Plurals (uses Intl.PluralRules with `locale`)
  commentsCount: { one: "{n} comment", other: "{n} comments" },
};

const cfg = window.PROTA_CONTACT_CONFIG;

// LABELS = defaults merged with per-project overrides. Shallow merge except
// `commentsCount` (and any nested label objects) get a single level of
// nested merge so projects can override just `commentsCount.few` without
// re-specifying every form.
const LABELS = (() => {
  const overrides = (cfg && cfg.REVIEW_LABELS) || {};
  const merged = Object.assign({}, DEFAULT_LABELS, overrides);
  // One-level deep merge for known nested keys
  for (const key of ["commentsCount"]) {
    if (overrides[key] && typeof overrides[key] === "object") {
      merged[key] = Object.assign({}, DEFAULT_LABELS[key], overrides[key]);
    }
  }
  return merged;
})();

// Plural-aware count formatter. Uses Intl.PluralRules on LABELS.locale
// and looks up the matching form in `tmpl` ({one, two, few, many, other}).
// Falls back to `tmpl.other`, then `tmpl.one`, then plain count.
function formatCount(n, key) {
  const tmpl = LABELS[key];
  if (!tmpl || typeof tmpl !== "object") return String(n);
  let form = "other";
  try {
    form = new Intl.PluralRules(LABELS.locale || "en").select(n);
  } catch (e) { /* fall through */ }
  const text = tmpl[form] || tmpl.other || tmpl.one || "{n}";
  return text.replace("{n}", String(n));
}

// Init only when Firebase config is present. Order matters: LABELS +
// formatCount above are needed by render functions that init() calls
// synchronously (renderBanner, renderSidebar, renderCommentList).
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

  // Expose za debugging + out-of-band akcije (Claude može da pozove
  // archiveComments(['id1', 'id2']) iz konzole posle primene izmena).
  window.__review = {
    state, db,
    archiveComments, unarchiveComment,
    editComment, deleteComment,
    isArchived,
  };
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
  const SKIP_SELECTOR = ".review-banner, .review-sidebar, .review-sidebar-toggle, .review-modal-backdrop, .review-pill, .review-pill-container, [data-review-skip], input, textarea, select, option, script, style";

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
  // Široka lista — bilo koji element koji sadrži smislen tekst može
  // dobiti anchor (filter ispod skida prazne wrappere).
  const TAGS = [
    "h1","h2","h3","h4","h5","h6",
    "p","li","summary","a","button","label",
    "blockquote","figcaption","details",
    "td","th","dt","dd",
    "strong","em","b","i","u","mark","cite","q",
    "small","code","pre","kbd","samp","var",
    "span","time","abbr",
    "div","section","article","aside","header","footer","nav","main","figure",
  ];
  const selector = TAGS.join(",") + ",.review-img-wrap";

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
    // Pill (only created on first hover; lazy). The pill lives inside a
    // .review-pill-container span — per library/features/review-widget/
    // css-isolation.md §"Has-comment element outline + hover pill", the
    // container takes pointer-events: none so the empty wrapper doesn't
    // intercept host-element clicks; the pill itself takes pointer-events:
    // auto when visible.
    el.addEventListener("mouseenter", () => {
      if (!el.querySelector(".review-pill-container")) {
        const container = document.createElement("span");
        container.className = "review-pill-container";
        const pill = document.createElement("button");
        pill.className = "review-pill";
        pill.type = "button";
        pill.textContent = "+";
        pill.title = LABELS.addCommentTitle;
        pill.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openModal(el, null);
        });
        container.appendChild(pill);
        el.appendChild(container);
        // Pill visibility for elements that already have comments
        decoratePill(el, pill);
      }
    });
  });
}

function decorateAnchors() {
  // Element-level status — per
  // library/features/review-widget/css-isolation.md §"Has-comment outline"
  // and library/features/review-widget/comment-lifecycle.md §"States".
  //   any pending             → .has-comment (warm amber outline)
  //   all non-archived applied → .has-applied-comment (sage outline)
  //   all archived / none      → no class (default subtle dashed outline only)
  document.querySelectorAll("[data-comment-id]").forEach((el) => {
    const id = el.getAttribute("data-comment-id");
    const mine = state.comments.filter((c) => c.anchor === id);
    const pending = mine.filter(isPending);
    const applied = mine.filter(isApplied);
    el.classList.remove("has-comment", "has-applied-comment");
    if (pending.length > 0) {
      el.classList.add("has-comment");
    } else if (applied.length > 0 && pending.length === 0) {
      el.classList.add("has-applied-comment");
    }
    const pill = el.querySelector(".review-pill");
    if (pill) decoratePill(el, pill);
  });
}

function decoratePill(el, pill) {
  // Pill na hover prikazuje boju koja signalizuje status:
  //   ima aktivnih → terakota (.has-comment)
  //   inače → default forest (no class)
  if (active.length) pill.classList.add("has-comment");
}

// =================================================================
// Modal
// =================================================================

// Otvara modal za novi komentar (existingComment === null) ili edit
// postojećeg (existingComment je objekat sa id, comment, replacement).
function openModal(el, existingComment) {
  const id = el.getAttribute("data-comment-id");
  const preview = el.textContent.trim().slice(0, 200);
  const isEdit = !!existingComment;

  const titleText = isEdit ? LABELS.modalTitleEdit : LABELS.modalTitleNew;
  const submitText = isEdit ? LABELS.modalSubmitEdit : LABELS.modalSubmitNew;
  const initComment = isEdit ? (existingComment.comment || "") : "";
  const initReplacement = isEdit ? (existingComment.replacement || "") : "";

  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal" role="dialog">
      <h3>${titleText}</h3>
      <div class="anchor-info">${escapeHtml(id)}</div>
      <div class="anchor-preview">"${escapeHtml(preview)}${preview.length === 200 ? "…" : ""}"</div>
      <label>${escapeHtml(LABELS.modalCommentLabel)} <span class="opt">${escapeHtml(LABELS.modalCommentHint)}</span></label>
      <textarea name="comment" rows="3" placeholder="${escapeHtml(LABELS.modalCommentPlaceholder)}" autofocus></textarea>
      <label>${escapeHtml(LABELS.modalReplacementLabel)} <span class="opt">${escapeHtml(LABELS.modalReplacementHint)}</span></label>
      <textarea name="replacement" rows="4" placeholder="${escapeHtml(LABELS.modalReplacementPlaceholder)}"></textarea>
      <div class="error" style="display:none"></div>
      <div class="actions">
        <button type="button" class="review-btn review-btn--secondary" data-cancel>${escapeHtml(LABELS.modalCancel)}</button>
        <button type="button" class="review-btn review-btn--primary" data-submit>${submitText}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  // Pre-popuni za edit mode
  backdrop.querySelector('textarea[name="comment"]').value = initComment;
  backdrop.querySelector('textarea[name="replacement"]').value = initReplacement;

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
      errEl.textContent = LABELS.modalRequiredError;
      errEl.style.display = "block";
      return;
    }
    try {
      if (isEdit) {
        await editComment(existingComment.id, { comment, replacement });
        close();
        toast(LABELS.saved);
      } else {
        await submitComment({
          page: computePageSlug(window.location.pathname),
          anchor: id,
          comment,
          replacement,
          text_preview: preview.slice(0, 280),
          url: window.location.href,
        });
        close();
        toast(LABELS.saved);
        // Otvori sidebar pa fokus ide na novi komentar
        const sb = document.querySelector(".review-sidebar");
        if (sb) {
          sb.classList.add("open");
          setTimeout(() => {
            const list = sb.querySelector("[data-list]");
            if (list) list.scrollTop = 0;
          }, 200);
        }
      }
    } catch (err) {
      errEl.textContent = LABELS.errorPrefix + err.message;
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
    status: "pending",
    user_agent: navigator.userAgent.slice(0, 200),
    timestamp: Date.now(),
  });
  // events.comment-created emitted at composition layer (toast on success);
  // a future analytics consumer can hook window.addEventListener("comment-created", ...).
}

// Apply transition (pending -> applied). Per
// library/features/review-widget/comment-lifecycle.md §"State transitions".
// Fires events.comment-applied per library/events/comment-applied.md.
async function applyComment(commentId) {
  const app = initializeApp(cfg.FIREBASE_CONFIG, "review-mode-write");
  const db = getDatabase(app);
  const now = Date.now();
  const cRef = ref(db, "comments/" + commentId);
  await update(cRef, { status: "applied", applied_at: now });
  // Emit event for downstream consumers (analytics, Slack notifier, etc.)
  const c = state.comments.find((c) => c.id === commentId);
  window.dispatchEvent(new CustomEvent("comment-applied", {
    detail: {
      id: commentId,
      pageSlug: c ? c.page : undefined,
      anchorId: c ? c.anchor : undefined,
      appliedAt: now,
    },
  }));
}

async function editComment(commentId, fields) {
  const app = initializeApp(cfg.FIREBASE_CONFIG, "review-mode-write");
  const db = getDatabase(app);
  const cRef = ref(db, "comments/" + commentId);
  await update(cRef, Object.assign({}, fields, { edited_at: Date.now() }));
}

async function deleteComment(commentId) {
  const app = initializeApp(cfg.FIREBASE_CONFIG, "review-mode-write");
  const db = getDatabase(app);
  const cRef = ref(db, "comments/" + commentId);
  // Realtime DB delete = update sa null
  await update(ref(db, "comments"), { [commentId]: null });
}

async function archiveComments(commentIds) {
  const app = initializeApp(cfg.FIREBASE_CONFIG, "review-mode-write");
  const db = getDatabase(app);
  const now = Date.now();
  const updates = {};
  for (const id of commentIds) {
    updates[id + "/status"] = "archived";
    updates[id + "/archived_at"] = now;
  }
  await update(ref(db, "comments"), updates);
}

async function unarchiveComment(commentId) {
  const app = initializeApp(cfg.FIREBASE_CONFIG, "review-mode-write");
  const db = getDatabase(app);
  await update(ref(db, "comments/" + commentId), {
    status: "pending",
    archived_at: null,
    applied_at: null,
  });
}

// =================================================================
// Banner + Sidebar
// =================================================================

function renderBanner() {
  const banner = document.createElement("div");
  banner.className = "review-banner";
  banner.innerHTML = `
    <div><span class="dot"></span> ${escapeHtml(LABELS.bannerText)} &middot; ${escapeHtml(LABELS.bannerHint)}</div>
    <div><a href="${window.location.pathname}">${escapeHtml(LABELS.bannerClose)}</a></div>`;
  document.body.appendChild(banner);
}

function renderSidebar() {
  const sb = document.createElement("aside");
  sb.className = "review-sidebar";
  sb.innerHTML = `
    <header>
      <span>${escapeHtml(LABELS.sidebarTitle)}</span>
      <span class="count" data-count>0</span>
    </header>
    <div class="filter-row">
      <button data-filter="active" class="active">${escapeHtml(LABELS.activeTab)}</button>
      <button data-filter="applied">${escapeHtml(LABELS.appliedTab)}</button>
      <button data-filter="archived">${escapeHtml(LABELS.archiveTab)}</button>
    </div>
    <div class="comments" data-list>
      <div class="empty">${escapeHtml(LABELS.noCommentsYet)}</div>
    </div>`;

  // Sidebar toggle for narrow screens
  const toggle = document.createElement("button");
  toggle.className = "review-sidebar-toggle";
  toggle.textContent = LABELS.toggleButton;
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
  const filterMode = state.filter;  // "active" | "applied" | "archived"
  // Group classification — per library/features/review-widget/pending-archived-workflow.md §"The model".
  //   active   — group has >= 1 pending comment
  //   applied  — all non-archived comments are applied (>= 1 applied, 0 pending)
  //   archived — all comments archived
  // Each comment belongs to exactly one filter group based on its anchor.
  const groupsByAnchor = new Map();
  for (const c of state.comments) {
    const key = c.anchor || LABELS.noAnchorFallback;
    if (!groupsByAnchor.has(key)) groupsByAnchor.set(key, []);
    groupsByAnchor.get(key).push(c);
  }
  function classifyGroup(comments) {
    const pending  = comments.filter(isPending).length;
    const applied  = comments.filter(isApplied).length;
    const archived = comments.filter(isArchived).length;
    if (pending > 0) return "active";
    if (applied > 0 && pending === 0) return "applied";
    if (archived === comments.length) return "archived";
    return "active";  // fallback
  }
  const filtered = state.comments.filter((c) => {
    const groupComments = groupsByAnchor.get(c.anchor || LABELS.noAnchorFallback) || [];
    return classifyGroup(groupComments) === filterMode;
  });

  countEl.textContent = state.comments.length;

  if (state.error) {
    listEl.innerHTML = `<div class="empty" style="color:#dc2626;">${escapeHtml(LABELS.dbReadErrorPrefix)}${escapeHtml(state.error)}<br/><br/><span style="font-size:11px;">${escapeHtml(LABELS.dbReadErrorHint)}</span></div>`;
    return;
  }

  if (!filtered.length) {
    let msg;
    if (filterMode === "archived") msg = LABELS.emptyArchive;
    else if (filterMode === "applied") msg = LABELS.emptyApplied || LABELS.noActiveComments;
    else msg = LABELS.noActiveComments;
    listEl.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }

  // Group comments by anchor. Within group: oldest first (natural reading
  // order, replies follow original). Group order: most recent activity
  // first (group sa najsvežijim komentarom ide na vrh).
  const groupsMap = new Map();
  for (const c of filtered) {
    const key = c.anchor || LABELS.noAnchorFallback;
    if (!groupsMap.has(key)) groupsMap.set(key, []);
    groupsMap.get(key).push(c);
  }
  const groups = Array.from(groupsMap.entries())
    .map(([anchor, comments]) => ({
      anchor,
      comments: comments.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)),
      latest: Math.max(...comments.map((c) => c.timestamp || c.archived_at || 0)),
    }))
    .sort((a, b) => b.latest - a.latest);

  listEl.innerHTML = groups.map((group) => {
    const groupHTML = group.comments.map((c) => {
      const status = getStatus(c);  // "pending" | "applied" | "archived"
      const when = c.timestamp ? new Date(c.timestamp).toLocaleString() : "";
      const editedNote = c.edited_at ? ` &middot; ${escapeHtml(LABELS.editedPrefix)} ${new Date(c.edited_at).toLocaleString()}` : "";
      const actions = renderActions(c.id, status);
      return `
        <div class="review-comment ${status}" data-comment="${c.id}" data-anchor="${escapeHtml(c.anchor || "")}">
          ${c.comment ? `<div class="text">${escapeHtml(c.comment)}</div>` : ""}
          ${c.replacement ? `<div class="replacement">${escapeHtml(c.replacement)}</div>` : ""}
          <div class="meta">
            <span>${when}${editedNote}</span>
          </div>
          <div class="actions">${actions}</div>
        </div>`;
    }).join("");

    const firstPreview = (group.comments[0] || {}).text_preview || "";
    const previewSlice = firstPreview.slice(0, 100);
    const previewHTML = firstPreview
      ? `<div class="anchor-preview">"${escapeHtml(previewSlice)}${firstPreview.length > 100 ? "…" : ""}"</div>`
      : "";
    const n = group.comments.length;
    
    // Group-level status badge — per library/features/review-widget/pending-archived-workflow.md
    // §"Status badges". Archived groups carry no badge (they only appear under the Archived
    // filter); active groups carry .pending; all-applied groups carry .applied.
    const groupStatus = classifyGroup(group.comments);
    let statusBadge = "";
    if (groupStatus === "active") {
      statusBadge = `<span class="group-status pending">${escapeHtml(LABELS.statusPending)}</span>`;
    } else if (groupStatus === "applied") {
      statusBadge = `<span class="group-status applied">${escapeHtml(LABELS.statusApplied)}</span>`;
    }
    // archived groups: no badge (they only render under Archived filter)
    // Note: nema „Mark as done" dugmeta — Claude trenutno
    // jedini izvršava komentare (arhivira ih kroz drugi mehanizam,
    // npr. direktan write u RTDB ili out-of-band akcija). Ako se
    // ikad pojavi human-in-the-loop role-a koja arhivira ručno,
    // archive funkcija je u JS-u (archiveComments), samo treba
    // restore-ovati group footer markup ovde.
    const groupFooter = "";

    return `
      <div class="review-group ${groupStatus}" data-anchor="${escapeHtml(group.anchor)}">
        <div class="review-group-header" data-anchor="${escapeHtml(group.anchor)}">
          <div class="anchor-row">
            <div class="anchor">${escapeHtml(group.anchor)}</div>
            ${statusBadge}
          </div>
          ${previewHTML}
          <div class="group-count">${escapeHtml(formatCount(n, "commentsCount"))}</div>
        </div>
        ${groupHTML}
        ${groupFooter}
      </div>`;
  }).join("");

  // Helper — scroll + spotlight (single source of truth)
  function spotlightAnchor(anchor) {
    const target = document.querySelector(`[data-comment-id="${cssEscape(anchor)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    document.querySelectorAll(".review-spotlit").forEach((el) => {
      el.classList.remove("review-spotlit");
    });
    // eslint-disable-next-line no-unused-expressions
    void target.offsetWidth;
    target.classList.add("review-spotlit");
    clearTimeout(window.__reviewSpotlightTimer);
    window.__reviewSpotlightTimer = setTimeout(() => {
      target.classList.remove("review-spotlit");
    }, 4000);
  }

  // Click on group header — scroll + spotlight
  listEl.querySelectorAll(".review-group-header").forEach((header) => {
    header.addEventListener("click", () => {
      spotlightAnchor(header.getAttribute("data-anchor"));
    });
  });

  // Click on the comment row body (anywhere except buttons)
  listEl.querySelectorAll(".review-comment").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      spotlightAnchor(row.getAttribute("data-anchor"));
    });
  });

  // Per-comment Apply — pending -> applied
  listEl.querySelectorAll("[data-action='apply']").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-comment");
      btn.disabled = true;
      try {
        await applyComment(id);
        toast(LABELS.applied);
      } catch (err) {
        console.error("[review-mode] apply failed:", err);
        toast(LABELS.errorPrefix + err.message);
        btn.disabled = false;
      }
    });
  });

  // Per-comment Archive — pending/applied -> archived
  listEl.querySelectorAll("[data-action='archive']").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-comment");
      btn.disabled = true;
      try {
        await archiveComments([id]);
        toast(LABELS.archived);
      } catch (err) {
        console.error("[review-mode] archive failed:", err);
        toast(LABELS.errorPrefix + err.message);
        btn.disabled = false;
      }
    });
  });

  // Per-comment Edit
  listEl.querySelectorAll("[data-action='edit']").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-comment");
      const comment = state.comments.find((c) => c.id === id);
      if (!comment) return;
      const anchorEl = document.querySelector(`[data-comment-id="${cssEscape(comment.anchor)}"]`);
      if (!anchorEl) {
        toast(LABELS.elementGone);
        return;
      }
      openModal(anchorEl, comment);
    });
  });

  // Per-comment Delete
  listEl.querySelectorAll("[data-action='delete']").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-comment");
      if (!confirm(LABELS.confirmDelete)) return;
      btn.disabled = true;
      try {
        await deleteComment(id);
        toast(LABELS.deleted);
      } catch (err) {
        console.error("[review-mode] delete failed:", err);
        toast(LABELS.errorPrefix + err.message);
        btn.disabled = false;
      }
    });
  });

  // Per-comment Restore (samo u arhivi)
  listEl.querySelectorAll("[data-action='restore']").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-comment");
      btn.disabled = true;
      try {
        await unarchiveComment(id);
        toast(LABELS.restoredToPending);
      } catch (err) {
        console.error("[review-mode] restore failed:", err);
        toast(LABELS.errorPrefix + err.message);
        btn.disabled = false;
      }
    });
  });

  // Note: nema „archive-group-btn" handler-a jer ne render-ujemo button.
  // archiveComments() funkcija ostaje u modulu — Claude (ili future
  // human-in-the-loop role-a) je može pozvati direktno preko window.__review
  // ili out-of-band Firebase write.
}

function renderActions(id, status) {
  // Per-status button matrix per
  // library/features/review-widget/comment-lifecycle.md §"Per-comment actions in the sidebar".
  //   pending  → Apply, Edit, Archive, Delete
  //   applied  → Restore, Archive, Delete
  //   archived → Restore, Delete
  const apply   = `<button data-comment="${id}" data-action="apply"   class="apply-btn"   title="${escapeHtml(LABELS.applyTitle)}">&#10004; ${escapeHtml(LABELS.applyLabel)}</button>`;
  const edit    = `<button data-comment="${id}" data-action="edit"    class="edit-btn"    title="${escapeHtml(LABELS.editTitle)}">&#9998; ${escapeHtml(LABELS.editLabel)}</button>`;
  const archive = `<button data-comment="${id}" data-action="archive" class="archive-btn" title="${escapeHtml(LABELS.archiveTitle)}">&#128450; ${escapeHtml(LABELS.archiveLabel)}</button>`;
  const restore = `<button data-comment="${id}" data-action="restore" class="restore-btn" title="${escapeHtml(LABELS.restoreTitle)}">&#8634; ${escapeHtml(LABELS.restoreLabel)}</button>`;
  const del     = `<button data-comment="${id}" data-action="delete"  class="delete-btn"  title="${escapeHtml(LABELS.deleteTitle)}">&#10005; ${escapeHtml(LABELS.deleteLabel)}</button>`;
  if (status === "archived") return restore + del;
  if (status === "applied")  return restore + archive + del;
  return apply + edit + archive + del;  // pending (default)
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
