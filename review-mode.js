// review-mode.js
//
// Re-composed 2026-05-15 against library/features/review-widget atomics
// (organization-template upstream commits f40cbe7..192de33):
//
//   - comment-lifecycle.md       (3-state: pending/applied/archived + commentLifecycleMode)
//   - pending-archived-workflow  (3 filter tabs: active/applied/archived + groupStatus)
//   - anchor-strategy.md         (canonical ANCHOR_TAGS; pageSlug-{tag}-{n})
//   - anchor-extensibility.md    (ANCHOR_TAGS_EXTRA + [data-comment-target] + MutationObserver)
//   - commentable-everything.md  (commentableContent + chromeAnchored + CHROME_COUNTERS)
//   - firebase-rtdb-adapter.md   (broad subscribe + client-side filter; status-enum write)
//   - spotlight-on-click.md      (single-spotlight policy)
//   - pill-hover-deepest.md      (:has() deepest-only + display:none baseline)
//   - css-isolation.md           (chrome-roots only; per-action suffix classes; class state)
//   - intl-plural-labels.md      (formatCount; LABELS.locale)
//   - inert-entry-button.md      (lives in review-bootstrap.js)
//
// Activated by ?review=1. Comments stored at /comments/{push-id} in Firebase RTDB
// (broad subscribe + client-side filter by `page` and the `__chrome__` cross-page
// bucket). Reader shim normalizes legacy boolean-archived records to the enum.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  onValue,
  update,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-database.js";

// =================================================================
// Module-level state. Declared before init() runs since init() (called
// below at module load) accesses state synchronously via closures.
// =================================================================

const state = {
  comments: [],
  filter: "active",          // 'active' | 'applied' | 'archived'  (filter-tab key — NOT status-enum)
  error: null,
  pageSlug: null,
  cfg: null,
  anchorObserver: null,      // MutationObserver, disconnected on exit
  commentableContent: "allowlist", // 'allowlist' | 'direct-text'
  chromeAnchored: false,
};

// =================================================================
// Status normalization — per comment-lifecycle.md §"Schema" and
// §"Backward compatibility — reader-side shim". The 3-state enum
// lives at c.status: 'pending' | 'applied' | 'archived'. Legacy
// records may carry boolean `archived: true` or `applied: true`
// (pre-2026-05-12b 2-state schema). We accept both shapes on read;
// new writes use the enum directly. The shim runs forever (or until
// a separate migration pass walks /comments/ and rewrites every
// record — prota: done 2026-05-13). The isPending/isApplied/
// isArchived helpers below are thin sugar over getStatus.
// =================================================================

function getStatus(c) {
  if (!c) return "pending";
  // Enum first — canonical post-2026-05-12b shape
  if (c.status === "pending" || c.status === "applied" || c.status === "archived") return c.status;
  // Legacy boolean shapes
  if (c.archived === true) return "archived";
  if (c.applied === true) return "applied";
  // Even-older string statuses ('applied'/'dismissed'/'open'/'reopen') from
  // the pre-2-state era — boolean shapes above win first.
  if (c.status === "applied") return "applied";   // legacy enum value
  if (c.status === "dismissed") return "archived"; // legacy enum value
  return "pending";
}
function isPending(c)  { return getStatus(c) === "pending"; }
function isApplied(c)  { return getStatus(c) === "applied"; }
function isArchived(c) { return getStatus(c) === "archived"; }

// =================================================================
// Group-level status (per pending-archived-workflow.md §"Sidebar filter
// tabs"). MUST return one of the filter-tab keys, NOT a status-enum
// value. See comment-lifecycle.md §"Vocabulary bridge".
// =================================================================

function groupStatus(groupComments) {
  const nonArchived = groupComments.filter((c) => getStatus(c) !== "archived");
  if (nonArchived.length === 0) return "archived";
  const allApplied = nonArchived.every((c) => getStatus(c) === "applied");
  if (allApplied) return "applied";
  return "active";
}

// =================================================================
// Labels (localizable via cfg.REVIEW_LABELS). English defaults.
// =================================================================

const DEFAULT_LABELS = {
  locale: "en",
  // Pill / element interaction
  addCommentTitle: "Add comment to this element",
  // Banner
  bannerText: "Review mode",
  bannerHint: "click any element to leave a comment",
  bannerClose: "Close",
  // Sidebar header + filter tabs (three tabs per the 3-state lifecycle)
  sidebarTitle: "Comments on this page",
  activeTab: "Active",
  appliedTab: "Applied",
  archiveTab: "Archive",
  // Empty states
  noCommentsYet: 'No comments yet. Hover over any element and click "+".',
  noActiveComments: 'No active comments yet. Hover over any element and click "+".',
  emptyApplied: "No applied comments yet.",
  emptyArchive: "Archive is empty.",
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
  // Toggle button (shared with inert-page entry button in bootstrap)
  toggleButton: "Comments",
  toggleButtonTitle: "Open comment review mode",
  // Group status badges
  statusPending: "Pending",
  statusApplied: "Applied",
  statusDone: "Done",  // legacy alias for statusApplied; kept for back-compat
  // Comment row meta
  editedPrefix: "edited",
  noAnchorFallback: "(no anchor)",
  // Action buttons — per comment-lifecycle.md §"Per-action class names".
  // The 'full' set includes Apply / Archive; 'feedback-only' uses only the
  // subset emitted in renderActions() below.
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
state.cfg = cfg;

// LABELS = defaults merged with per-project overrides. One-level deep
// merge for known nested keys so projects override individual plural
// forms without re-specifying every form.
const LABELS = (() => {
  const overrides = (cfg && cfg.REVIEW_LABELS) || {};
  const merged = Object.assign({}, DEFAULT_LABELS, overrides);
  for (const key of ["commentsCount"]) {
    if (overrides[key] && typeof overrides[key] === "object") {
      merged[key] = Object.assign({}, DEFAULT_LABELS[key], overrides[key]);
    }
  }
  return merged;
})();

// Plural-aware count formatter — per intl-plural-labels.md.
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

// =================================================================
// Config gates (per FEATURE.md §"Project-specific inputs"). Default
// behavior is unchanged when keys are unset; opt-ins are per-project
// and the in-memory `state` carries the resolved values for the rest
// of the module.
// =================================================================

const lifecycleMode = (cfg && cfg.commentLifecycleMode) || "full";
const isFeedbackOnly = lifecycleMode === "feedback-only";

state.commentableContent = (cfg && cfg.commentableContent) || "allowlist";
state.chromeAnchored = !!(cfg && cfg.chromeAnchored);

// Canonical ANCHOR_TAGS — per anchor-strategy.md §"Which elements get
// anchored". Curated tight list (does NOT include `div`, `a`, `button`,
// etc.). Project-level extension via ANCHOR_TAGS_EXTRA below.
const ANCHOR_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "li", "td", "th", "dt", "dd",
  "strong", "em", "small", "span",
  "section", "article", "aside", "header", "footer", "nav", "main", "figure",
];

// Per-project tag extension — per anchor-extensibility.md §1.
const ANCHOR_TAGS_EXTRA = (cfg && Array.isArray(cfg.ANCHOR_TAGS_EXTRA))
  ? cfg.ANCHOR_TAGS_EXTRA.slice()
  : [];

const ANCHOR_TAGS_EFFECTIVE = ANCHOR_TAGS.concat(ANCHOR_TAGS_EXTRA);

// Curated deny-list for direct-text mode (per commentable-everything.md
// §"NEVER_ANCHOR deny-list"). Also referenced in allowlist mode by
// `tryAnchor()` as defense-in-depth.
const NEVER_ANCHOR = new Set([
  // Interactive form controls — pill click conflict + can't host children
  "input", "select", "textarea", "option", "optgroup", "datalist",
  "fieldset", "legend",
  // Non-visual / metadata
  "script", "style", "template", "noscript", "meta", "link", "title",
  "head", "html", "body",
  // SVG internals
  "svg", "path", "circle", "rect", "ellipse", "polygon", "polyline",
  "line", "g", "use", "defs", "symbol", "marker",
  // Embedded content
  "iframe", "embed", "object", "param",
  // Void elements (no children possible)
  "br", "hr", "img", "video", "audio", "source", "track", "picture",
  // Layout-only table elements
  "col", "colgroup",
]);

// =================================================================
// Module-scoped sticky counters (per anchor-extensibility.md §"Counter
// stickiness"). NEVER reset between init and MutationObserver-driven
// passes — re-numbering would orphan existing comments.
// =================================================================

const ANCHOR_COUNTERS = Object.create(null);   // {tag: lastN} — per pageSlug-{tag}-{n}
const CHROME_COUNTERS = Object.create(null);   // {tag: lastN} — per chrome-{tag}-{n}

// =================================================================
// Init guard is at the BOTTOM of this file. JS function declarations
// are hoisted, but `const` declarations have a Temporal Dead Zone —
// referencing a const from inside a hoisted function BEFORE the const
// has executed throws ReferenceError. WIDGET_CHROME_SELECTOR (and a few
// other module-level consts) is declared later in the file; calling
// init() here (before those consts execute) would TDZ-throw on the first
// isInWidgetChrome() call. Keeping init() at the bottom means every
// module-level const has executed by the time init() runs.
// =================================================================

function init() {
  const app = initializeApp(cfg.FIREBASE_CONFIG, "review-mode");
  const db = getDatabase(app);

  document.documentElement.setAttribute("data-review-mode", "on");

  // Page slug — per anchor-strategy.md §"The ID shape" pageSlug rule.
  // /                    → 'home'
  // /about/              → 'about'
  // /work/citi-ventures/ → 'work-citi-ventures'
  state.pageSlug = computePageSlug(window.location.pathname);

  // Initial anchor pass over the content area. Chrome inclusion is
  // gated by state.chromeAnchored.
  anchorPage();

  // Dynamic-content support — per anchor-extensibility.md §3.
  setupDynamicAnchoring();

  renderBanner();

  const sidebar = renderSidebar();
  document.body.appendChild(sidebar);

  wireAnchors();

  // Broad subscribe + client-side filter — per firebase-rtdb-adapter.md.
  // Filter accepts records whose `page` is the current pageSlug OR the
  // cross-page chrome bucket '__chrome__' (per commentable-everything.md
  // §"Comment-read filter").
  console.log("[review-mode] page slug:", state.pageSlug, "chrome:", state.chromeAnchored);
  const commentsRef = ref(db, "comments");
  onValue(commentsRef, (snap) => {
    const data = snap.val() || {};
    const all = Object.entries(data).map(([id, val]) => ({ id, ...val }));
    state.comments = all.filter((c) => c.page === state.pageSlug || c.page === "__chrome__");
    console.log(`[review-mode] ${all.length} total, ${state.comments.length} on this page (+ chrome)`);
    renderCommentList();
    decorateAnchors();
  }, (err) => {
    console.error("[review-mode] read failed:", err);
    state.error = err.message;
    renderCommentList();
  });

  // Debug + out-of-band actions (Claude can call window.__review.* from
  // the console after applying changes in source — used by the
  // feedback-only workflow that doesn't expose Apply/Archive in the UI).
  window.__review = {
    state, db,
    applyComment, archiveComment, archiveComments, restoreComment,
    unarchiveComment: restoreComment,  // back-compat alias for the prior 2-state API
    editComment, deleteComment,
    getStatus, groupStatus,
    isPending, isApplied, isArchived,
  };
}

// =================================================================
// Page slug
// =================================================================

function computePageSlug(pathname) {
  // Strip trailing /index.html or /index.htm
  let p = pathname.replace(/\/index\.html?$/i, "/");
  const trimmed = p.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "home";
  return trimmed.replace(/\//g, "-");
}

// =================================================================
// Anchor pass — per anchor-strategy.md + anchor-extensibility.md +
// commentable-everything.md. The full tag-list pass plus the
// [data-comment-target] attribute pass.
// =================================================================

const WIDGET_CHROME_SELECTOR =
  ".review-banner, .review-sidebar, .review-sidebar-toggle, " +
  ".review-modal-backdrop, .review-modal, .review-toast, " +
  ".review-pill, .review-pill-container, .review-toggle-btn, " +
  "[data-review-skip], script, style";

function isInWidgetChrome(el) {
  return !!(el.closest && el.closest(WIDGET_CHROME_SELECTOR));
}

function isInSiteChrome(el) {
  // Per commentable-everything.md §"isInSiteChrome(el)". `nav` + `footer`
  // unconditionally; `header[role="banner"]` (semantic-banner role assertion;
  // non-banner `<header>` inside an `<article>` is content, not chrome).
  return !!(el.closest && el.closest('nav, header[role="banner"], footer'));
}

function selectContentArea() {
  // Per anchor-strategy.md §"Content area scoping". When chromeAnchored:
  // true (per commentable-everything.md), the area expands to document.body
  // so the chrome-route gate in tryAnchor() actually has chrome to walk over.
  if (state.chromeAnchored) return document.body;
  const main = document.querySelector("main");
  if (main) return main;
  return document.body;
}

function hasDirectText(el) {
  // Per commentable-everything.md §"hasDirectText(el)". Looks at the
  // element's OWN text-node children (not descendants). `<div><p>x</p></div>`
  // returns false (the `<div>`'s child is an element node, not a text node).
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length >= 2) {
      return true;
    }
  }
  return false;
}

function tryAnchor(el) {
  // Per commentable-everything.md §"tryAnchor(el) — direct-text + chrome-aware"
  // and anchor-extensibility.md §3. Decision points: widget-chrome skip,
  // already-anchored skip, opt-out skip, mode-gated allowlist-vs-direct-text,
  // chrome-route gate, ID assignment.

  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (isInWidgetChrome(el)) return false;
  if (el.hasAttribute("data-comment-id")) return false;
  if (el.hasAttribute("data-review-skip")) return false;
  const tag = el.tagName.toLowerCase();

  // Wrap <img> in a span so the pill can anchor next to it. (Voids can't
  // host children.) The wrapper carries `.review-img-wrap` and is what we
  // actually anchor, with tag bucket 'img' for slug stability.
  // Note: <img>s are processed by wrapImages() before tryAnchor() ever
  // sees them, so the path here is for raw <img> elements that escape
  // the initial pass (rare). The wrapper itself is matched below as a
  // span with `.review-img-wrap` class.

  // Mode-gated checks
  if (state.commentableContent === "direct-text") {
    if (NEVER_ANCHOR.has(tag)) return false;
    if (!hasDirectText(el)) return false;
  } else {
    // 'allowlist' mode — canonical + extras + per-element opt-in
    const matchesTag = ANCHOR_TAGS_EFFECTIVE.includes(tag);
    const optedIn = el.hasAttribute("data-comment-target");
    const isImgWrap = el.classList && el.classList.contains("review-img-wrap");
    if (!matchesTag && !optedIn && !isImgWrap) return false;
    if (NEVER_ANCHOR.has(tag)) return false;
    if (!isImgWrap) {
      const text = (el.textContent || "").trim();
      if (text.length < 2) return false;
    }
  }

  // Chrome-route gate
  const inSiteChrome = isInSiteChrome(el);
  if (inSiteChrome && !state.chromeAnchored) return false;

  // ID assignment — chrome uses cross-page CHROME_COUNTERS, content uses
  // page-scope ANCHOR_COUNTERS. Tag bucket for image-wraps is 'img' so
  // the slug is `{pageSlug}-img-{n}` or `chrome-img-{n}`.
  const bucket = (el.classList && el.classList.contains("review-img-wrap")) ? "img" : tag;
  let id;
  if (inSiteChrome) {
    CHROME_COUNTERS[bucket] = (CHROME_COUNTERS[bucket] || 0) + 1;
    id = `chrome-${bucket}-${CHROME_COUNTERS[bucket]}`;
    el.setAttribute("data-chrome-anchor", "");
  } else {
    ANCHOR_COUNTERS[bucket] = (ANCHOR_COUNTERS[bucket] || 0) + 1;
    id = `${state.pageSlug}-${bucket}-${ANCHOR_COUNTERS[bucket]}`;
  }
  el.setAttribute("data-comment-id", id);
  return true;
}

function wrapImages(root) {
  // Step 1 of the anchor pass — wrap every <img> so it can host a pill.
  // Skips images already inside widget chrome, opt-outs, or an existing
  // .review-img-wrap. Idempotent.
  root.querySelectorAll("img").forEach((img) => {
    if (isInWidgetChrome(img)) return;
    if (img.hasAttribute("data-review-skip")) return;
    if (img.parentElement && img.parentElement.classList &&
        img.parentElement.classList.contains("review-img-wrap")) return;
    const wrap = document.createElement("span");
    wrap.className = "review-img-wrap";
    wrap.style.cssText =
      "display: inline-block; position: relative; line-height: 0; max-width: 100%;";
    if (img.parentNode) {
      img.parentNode.insertBefore(wrap, img);
      wrap.appendChild(img);
    }
  });
}

function anchorPage() {
  const root = selectContentArea();
  wrapImages(root);
  anchorSubtree(root);
}

function anchorSubtree(rootNode) {
  // Walk the subtree breadth-first. The traversal order matters only
  // insofar as document-order gives stable counters — querySelectorAll
  // returns document-order natively.

  if (state.commentableContent === "direct-text") {
    // Direct-text mode — iterate every element and let tryAnchor decide.
    const all = rootNode.querySelectorAll ? rootNode.querySelectorAll("*") : [];
    all.forEach((el) => tryAnchor(el));
    if (rootNode.nodeType === Node.ELEMENT_NODE) tryAnchor(rootNode);
    return;
  }

  // Allowlist mode — two passes (tag-list, then attribute), de-duped by
  // tryAnchor's already-anchored check.
  for (const tag of ANCHOR_TAGS_EFFECTIVE) {
    if (rootNode.tagName && rootNode.tagName.toLowerCase() === tag) {
      tryAnchor(rootNode);
    }
    if (rootNode.querySelectorAll) {
      rootNode.querySelectorAll(tag).forEach((el) => tryAnchor(el));
    }
  }
  // Image wraps
  if (rootNode.classList && rootNode.classList.contains("review-img-wrap")) {
    tryAnchor(rootNode);
  }
  if (rootNode.querySelectorAll) {
    rootNode.querySelectorAll(".review-img-wrap").forEach((el) => tryAnchor(el));
  }
  // Per-element opt-in attribute
  if (rootNode.matches && rootNode.matches("[data-comment-target]")) {
    tryAnchor(rootNode);
  }
  if (rootNode.querySelectorAll) {
    rootNode.querySelectorAll("[data-comment-target]").forEach((el) => tryAnchor(el));
  }
}

function setupDynamicAnchoring() {
  // Per anchor-extensibility.md §3 + §"Performance considerations".
  // Scope is the content area (NOT document.body unless chromeAnchored:
  // true, in which case content area IS document.body). Config is
  // childList + subtree only.
  const root = selectContentArea();
  if (!root || !window.MutationObserver) return;
  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
        if (isInWidgetChrome(node)) continue;
        // Process new images first so the wrap-and-anchor sequence is
        // correct for dynamically inserted <img> tags.
        wrapImages(node);
        anchorSubtree(node);
        // Pills need wiring for elements added after init
        wireAnchorsIn(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  state.anchorObserver = observer;
}

// =================================================================
// Pill wiring (lazy — created on first mouseenter per anchored element)
// =================================================================

function wireAnchors() {
  const all = document.body.querySelectorAll("[data-comment-id]");
  all.forEach(wireOne);
}

function wireAnchorsIn(rootNode) {
  if (rootNode.hasAttribute && rootNode.hasAttribute("data-comment-id")) {
    wireOne(rootNode);
  }
  if (rootNode.querySelectorAll) {
    rootNode.querySelectorAll("[data-comment-id]").forEach(wireOne);
  }
}

function wireOne(el) {
  if (el.__reviewWired) return;
  el.__reviewWired = true;
  el.addEventListener("mouseenter", () => {
    if (el.querySelector(".review-pill-container")) return;
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
    decoratePill(el, pill);
  });
}

function decorateAnchors() {
  // Per css-isolation.md §"Has-comment element outline + hover pill"
  // and comment-lifecycle.md §"States". State is represented as a CLASS
  // on the anchored element:
  //   .has-comment         — group has any pending comments (warm amber outline)
  //   .has-applied-comment — group's non-archived comments are all applied (sage outline)
  //   (none)               — all archived or no comments (default subtle dashed outline only)
  // Classes (not data attributes) so they compose cleanly with other
  // state classes like .review-spotlit.
  document.querySelectorAll("[data-comment-id]").forEach((el) => {
    const id = el.getAttribute("data-comment-id");
    const groupComments = state.comments.filter((c) => c.anchor === id);
    el.classList.remove("has-comment", "has-applied-comment");
    if (groupComments.length > 0) {
      const gs = groupStatus(groupComments);
      if (gs === "active") el.classList.add("has-comment");
      else if (gs === "applied") el.classList.add("has-applied-comment");
    }
    const pill = el.querySelector(".review-pill");
    if (pill) decoratePill(el, pill);
  });
}

function decoratePill(el, pill) {
  pill.classList.remove("has-comment", "has-applied-comment");
  if (el.classList.contains("has-comment")) pill.classList.add("has-comment");
  else if (el.classList.contains("has-applied-comment")) pill.classList.add("has-applied-comment");
}

// =================================================================
// Modal — new + edit
// =================================================================

function openModal(el, existingComment) {
  const id = el.getAttribute("data-comment-id");
  const preview = (el.textContent || "").trim().slice(0, 200);
  const isEdit = !!existingComment;

  const titleText = isEdit ? LABELS.modalTitleEdit : LABELS.modalTitleNew;
  const submitText = isEdit ? LABELS.modalSubmitEdit : LABELS.modalSubmitNew;
  const initComment = isEdit ? (existingComment.comment || "") : "";
  const initReplacement = isEdit ? (existingComment.replacement || "") : "";

  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal" role="dialog">
      <h3>${escapeHtml(titleText)}</h3>
      <div class="anchor-info">${escapeHtml(id)}</div>
      <div class="anchor-preview">"${escapeHtml(preview)}${preview.length === 200 ? "…" : ""}"</div>
      <label>${escapeHtml(LABELS.modalCommentLabel)} <span class="opt">${escapeHtml(LABELS.modalCommentHint)}</span></label>
      <textarea name="comment" rows="3" placeholder="${escapeHtml(LABELS.modalCommentPlaceholder)}" autofocus></textarea>
      <label>${escapeHtml(LABELS.modalReplacementLabel)} <span class="opt">${escapeHtml(LABELS.modalReplacementHint)}</span></label>
      <textarea name="replacement" rows="4" placeholder="${escapeHtml(LABELS.modalReplacementPlaceholder)}"></textarea>
      <div class="error" style="display:none"></div>
      <div class="actions">
        <button type="button" class="review-btn review-btn--secondary" data-cancel>${escapeHtml(LABELS.modalCancel)}</button>
        <button type="button" class="review-btn review-btn--primary" data-submit>${escapeHtml(submitText)}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

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
        // Chrome-anchored anchors get page='__chrome__' per
        // commentable-everything.md §"Comment-write routing".
        const isChrome = String(id).startsWith("chrome-");
        await submitComment({
          page: isChrome ? "__chrome__" : state.pageSlug,
          anchor: id,
          comment,
          replacement,
          text_preview: preview.slice(0, 280),
          url: window.location.href,
        });
        close();
        toast(LABELS.saved);
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

// =================================================================
// Lifecycle operations — per comment-lifecycle.md §"State transitions"
// + firebase-rtdb-adapter.md §"Operations". New writes use the enum
// directly; legacy boolean records are normalized by getStatus() on read.
// =================================================================

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
  // RTDB delete = update with null
  await update(ref(db, "comments"), { [commentId]: null });
}

async function archiveComment(commentId) {
  const app = initializeApp(cfg.FIREBASE_CONFIG, "review-mode-write");
  const db = getDatabase(app);
  await update(ref(db, "comments/" + commentId), {
    status: "archived",
    archived_at: Date.now(),
  });
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

async function restoreComment(commentId) {
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
  // Three filter tabs per pending-archived-workflow.md §"Sidebar filter tabs".
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

  // Sidebar toggle for narrow screens (shared label keys with the
  // inert-page entry button per inert-entry-button.md §"Label resolution").
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

  countEl.textContent = state.comments.length;

  if (state.error) {
    listEl.innerHTML = `<div class="empty" style="color:#dc2626;">${escapeHtml(LABELS.dbReadErrorPrefix)}${escapeHtml(state.error)}<br/><br/><span style="font-size:11px;">${escapeHtml(LABELS.dbReadErrorHint)}</span></div>`;
    return;
  }

  // Group comments by anchor, then filter groups by the active filter-tab
  // key via groupStatus() — per pending-archived-workflow.md §"State
  // transitions at group level" + comment-lifecycle.md §"Vocabulary bridge".
  const groupsMap = new Map();
  for (const c of state.comments) {
    const key = c.anchor || LABELS.noAnchorFallback;
    if (!groupsMap.has(key)) groupsMap.set(key, []);
    groupsMap.get(key).push(c);
  }

  const allGroups = Array.from(groupsMap.entries()).map(([anchor, comments]) => ({
    anchor,
    comments: comments.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)),
    status: groupStatus(comments),
    latest: Math.max(...comments.map((c) => c.timestamp || c.archived_at || c.applied_at || 0)),
  }));

  const groups = allGroups
    .filter((g) => g.status === state.filter)
    .sort((a, b) => b.latest - a.latest);

  if (!groups.length) {
    const msg = state.filter === "archived" ? LABELS.emptyArchive
              : state.filter === "applied"  ? LABELS.emptyApplied
              : LABELS.noActiveComments;
    listEl.innerHTML = `<div class="empty">${escapeHtml(msg)}</div>`;
    return;
  }

  listEl.innerHTML = groups.map((group) => {
    const groupHTML = group.comments.map((c) => {
      const cStatus = getStatus(c);
      const when = c.timestamp ? new Date(c.timestamp).toLocaleString() : "";
      const editedNote = c.edited_at
        ? ` &middot; ${escapeHtml(LABELS.editedPrefix)} ${new Date(c.edited_at).toLocaleString()}`
        : "";
      const actions = renderActions(c.id, cStatus);
      return `
        <div class="review-comment ${escapeHtml(cStatus)}" data-comment="${escapeHtml(c.id)}" data-anchor="${escapeHtml(c.anchor || "")}">
          ${c.comment ? `<div class="text">${escapeHtml(c.comment)}</div>` : ""}
          ${c.replacement ? `<div class="replacement">${escapeHtml(c.replacement)}</div>` : ""}
          <div class="meta">
            <span>${escapeHtml(when)}${editedNote}</span>
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

    // Group-level status badge — per pending-archived-workflow.md §"Status
    // badges". Archived groups carry no badge (they only appear under the
    // Archived filter); active groups carry .pending; all-applied groups
    // carry .applied.
    let statusBadge = "";
    if (group.status === "active") {
      statusBadge = `<span class="group-status pending">${escapeHtml(LABELS.statusPending)}</span>`;
    } else if (group.status === "applied") {
      statusBadge = `<span class="group-status applied">${escapeHtml(LABELS.statusApplied)}</span>`;
    }

    // Group footer — bulk-archive button. Suppressed in feedback-only mode
    // per pending-archived-workflow.md §"Composition responsibilities".
    // Also suppressed on the archived filter (no archive op meaningful).
    // Prota runs feedback-only: Claude archives via RTDB out-of-band; no
    // human-in-the-loop archive role uses the in-UI button.
    const groupFooter = "";

    return `
      <div class="review-group ${escapeHtml(group.status)}" data-anchor="${escapeHtml(group.anchor)}">
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

  // Helper — single-spotlight scroll + outline per spotlight-on-click.md.
  function spotlightAnchor(anchor) {
    const target = document.querySelector(`[data-comment-id="${cssEscape(anchor)}"]`);
    if (!target) { toast(LABELS.elementGone); return; }
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

  listEl.querySelectorAll(".review-group-header").forEach((header) => {
    header.addEventListener("click", () => spotlightAnchor(header.getAttribute("data-anchor")));
  });

  listEl.querySelectorAll(".review-comment").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      spotlightAnchor(row.getAttribute("data-anchor"));
    });
  });

  // Per-action button handlers — only the buttons actually rendered will
  // match. `renderActions()` is the single source of truth for which
  // buttons exist per (status, lifecycleMode). In feedback-only mode (prota
  // default) the Apply / Archive selectors below match nothing because
  // renderActions() doesn't emit those buttons.
  listEl.querySelectorAll("[data-action='edit']").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-comment");
      const comment = state.comments.find((c) => c.id === id);
      if (!comment) return;
      const anchorEl = document.querySelector(`[data-comment-id="${cssEscape(comment.anchor)}"]`);
      if (!anchorEl) { toast(LABELS.elementGone); return; }
      openModal(anchorEl, comment);
    });
  });

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

  listEl.querySelectorAll("[data-action='restore']").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-comment");
      btn.disabled = true;
      try {
        await restoreComment(id);
        toast(LABELS.restoredToPending || LABELS.restoredToActive);
      } catch (err) {
        console.error("[review-mode] restore failed:", err);
        toast(LABELS.errorPrefix + err.message);
        btn.disabled = false;
      }
    });
  });

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

  listEl.querySelectorAll("[data-action='archive']").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-comment");
      btn.disabled = true;
      try {
        await archiveComment(id);
        toast(LABELS.archived);
      } catch (err) {
        console.error("[review-mode] archive failed:", err);
        toast(LABELS.errorPrefix + err.message);
        btn.disabled = false;
      }
    });
  });
}

function renderActions(id, status) {
  // Per comment-lifecycle.md §"Per-comment actions in the sidebar":
  //
  //   commentLifecycleMode: 'full' (review-board workflow)
  //     pending:  Apply, Edit, Archive, Delete
  //     applied:  Restore, Archive, Delete
  //     archived: Restore, Delete
  //
  //   commentLifecycleMode: 'feedback-only' (Claude-as-operator workflow)
  //     pending:  Edit, Delete
  //     applied:  Restore, Delete
  //     archived: Restore, Delete
  //
  // The buttons that DO render carry per-action suffix classes per
  // css-isolation.md §"Per-action suffix classes" so each gets distinct
  // hover styling.

  const btn = (action, klass, label, title, glyph) =>
    `<button data-comment="${escapeHtml(id)}" data-action="${action}" class="${klass}" title="${escapeHtml(title)}">${glyph} ${escapeHtml(label)}</button>`;

  if (isFeedbackOnly) {
    if (status === "pending") {
      return btn("edit", "edit-btn", LABELS.editLabel, LABELS.editTitle, "&#9998;") +
             btn("delete", "delete-btn", LABELS.deleteLabel, LABELS.deleteTitle, "&#10005;");
    }
    // applied or archived
    return btn("restore", "restore-btn", LABELS.restoreLabel, LABELS.restoreTitle, "&#8634;") +
           btn("delete", "delete-btn", LABELS.deleteLabel, LABELS.deleteTitle, "&#10005;");
  }

  // 'full' mode
  if (status === "pending") {
    return btn("apply", "apply-btn", LABELS.applyLabel, LABELS.applyTitle, "&#10003;") +
           btn("edit", "edit-btn", LABELS.editLabel, LABELS.editTitle, "&#9998;") +
           btn("archive", "archive-btn", LABELS.archiveLabel, LABELS.archiveTitle, "&#128451;") +
           btn("delete", "delete-btn", LABELS.deleteLabel, LABELS.deleteTitle, "&#10005;");
  }
  if (status === "applied") {
    return btn("restore", "restore-btn", LABELS.restoreLabel, LABELS.restoreTitle, "&#8634;") +
           btn("archive", "archive-btn", LABELS.archiveLabel, LABELS.archiveTitle, "&#128451;") +
           btn("delete", "delete-btn", LABELS.deleteLabel, LABELS.deleteTitle, "&#10005;");
  }
  // archived
  return btn("restore", "restore-btn", LABELS.restoreLabel, LABELS.restoreTitle, "&#8634;") +
         btn("delete", "delete-btn", LABELS.deleteLabel, LABELS.deleteTitle, "&#10005;");
}

// =================================================================
// Helpers
// =================================================================

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str == null ? "" : str);
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

// =================================================================
// Init guard — kept at the BOTTOM of the file. See the comment above
// the `function init()` declaration for the TDZ-avoidance rationale.
// By this point in module evaluation, every module-level `const`
// (WIDGET_CHROME_SELECTOR, ANCHOR_TAGS_EFFECTIVE, NEVER_ANCHOR,
// CHROME_COUNTERS, etc.) has been initialized, so init() — and the
// function it calls — can reference them safely.
// =================================================================

if (!cfg || !cfg.FIREBASE_CONFIG) {
  console.error("[review-mode] missing PROTA_CONTACT_CONFIG.FIREBASE_CONFIG");
} else {
  init();
}
