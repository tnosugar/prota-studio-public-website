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
  filter: "active", // "active" | "archived"
  error: null,
};

// ---------- Comment lifecycle helpers (shared) ----------
// Comment shape u Firebase RTDB:
//   /comments/{push-id}
//     page, anchor, comment, replacement, text_preview, url, timestamp,
//     user_agent
//     archived: bool        — true znači u arhivi, false/undefined je aktivan
//     archived_at: number   — timestamp arhiviranja
//     edited_at: number     — timestamp poslednje izmene
//
// Legacy support: stari komentari sa `status: "applied"` ili `"dismissed"`
// se tretiraju kao archived.
function isArchived(c) {
  if (c.archived === true) return true;
  if (c.status === "applied" || c.status === "dismissed") return true;
  return false;
}

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
    // Pill (only created on first hover; lazy)
    el.addEventListener("mouseenter", () => {
      if (!el.querySelector(".review-pill")) {
        const pill = document.createElement("button");
        pill.className = "review-pill";
        pill.type = "button";
        pill.textContent = "+";
        pill.title = "Dodaj komentar na ovaj element";
        pill.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openModal(el, null);
        });
        el.appendChild(pill);
        // Pill visibility for elements that already have comments
        decoratePill(el, pill);
      }
    });
  });
}

function decorateAnchors() {
  // Element-level status: ima li aktivnih (non-archived) komentara?
  // Pending  → has-comment class (subtle terakota dashed outline)
  // Empty / svi arhivirani → bez outline-a (vraća se u „čisto" stanje)
  document.querySelectorAll("[data-comment-id]").forEach((el) => {
    const id = el.getAttribute("data-comment-id");
    const active = state.comments.filter((c) => c.anchor === id && !isArchived(c));
    el.classList.remove("has-comment", "has-applied-comment");
    if (active.length) el.classList.add("has-comment");
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

  const titleText = isEdit ? "Uredi komentar" : "Novi komentar";
  const submitText = isEdit ? "Save changes" : "Save comment";
  const initComment = isEdit ? (existingComment.comment || "") : "";
  const initReplacement = isEdit ? (existingComment.replacement || "") : "";

  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal" role="dialog">
      <h3>${titleText}</h3>
      <div class="anchor-info">${escapeHtml(id)}</div>
      <div class="anchor-preview">"${escapeHtml(preview)}${preview.length === 200 ? "…" : ""}"</div>
      <label>Comment <span class="opt">(what to change, why)</span></label>
      <textarea name="comment" rows="3" placeholder="Shorten this, drop the second sentence…" autofocus></textarea>
      <label>Replacement suggestion <span class="opt">(optional — verbatim text if you have it)</span></label>
      <textarea name="replacement" rows="4" placeholder="(optional) exact replacement text…"></textarea>
      <div class="error" style="display:none"></div>
      <div class="actions">
        <button type="button" class="secondary" data-cancel>Cancel</button>
        <button type="button" class="primary" data-submit>${submitText}</button>
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
      errEl.textContent = "Komentar ili predlog zamene je obavezan.";
      errEl.style.display = "block";
      return;
    }
    try {
      if (isEdit) {
        await editComment(existingComment.id, { comment, replacement });
        close();
        toast("Saved.");
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
        toast("Saved.");
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
      errEl.textContent = "Error: " + err.message;
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
    archived: false,
    user_agent: navigator.userAgent.slice(0, 200),
    timestamp: Date.now(),
  });
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
    updates[id + "/archived"] = true;
    updates[id + "/archived_at"] = now;
  }
  await update(ref(db, "comments"), updates);
}

async function unarchiveComment(commentId) {
  const app = initializeApp(cfg.FIREBASE_CONFIG, "review-mode-write");
  const db = getDatabase(app);
  await update(ref(db, "comments/" + commentId), { archived: false, archived_at: null });
}

// =================================================================
// Banner + Sidebar
// =================================================================

function renderBanner() {
  const banner = document.createElement("div");
  banner.className = "review-banner";
  banner.innerHTML = `
    <div><span class="dot"></span> Review mode &middot; click any element to leave a comment</div>
    <div><a href="${window.location.pathname}">Zatvori</a></div>`;
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
      <button data-filter="active" class="active">Active</button>
      <button data-filter="archived">Archive</button>
    </div>
    <div class="comments" data-list>
      <div class="empty">No comments yet. Hover over any element and click "+".</div>
    </div>`;

  // Sidebar toggle for narrow screens
  const toggle = document.createElement("button");
  toggle.className = "review-sidebar-toggle";
  toggle.textContent = "Komentari";
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
  const wantArchived = state.filter === "archived";
  const filtered = state.comments.filter((c) => isArchived(c) === wantArchived);

  countEl.textContent = state.comments.length;

  if (state.error) {
    listEl.innerHTML = `<div class="empty" style="color:#dc2626;">Error reading database: ${escapeHtml(state.error)}<br/><br/><span style="font-size:11px;">Likely missing a read rule on /comments. Check Firebase rules.</span></div>`;
    return;
  }

  if (!filtered.length) {
    const msg = wantArchived
      ? 'Archive is empty. Comments are archived when you click "Mark as done".'
      : 'No active comments yet. Hover over any element and click "+".';
    listEl.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }

  // Group comments by anchor. Within group: oldest first (natural reading
  // order, replies follow original). Group order: most recent activity
  // first (group sa najsvežijim komentarom ide na vrh).
  const groupsMap = new Map();
  for (const c of filtered) {
    const key = c.anchor || "(no anchor)";
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
      const archived = isArchived(c);
      const when = c.timestamp ? new Date(c.timestamp).toLocaleString() : "";
      const editedNote = c.edited_at ? ` &middot; edited ${new Date(c.edited_at).toLocaleString()}` : "";
      const actions = renderActions(c.id, archived);
      return `
        <div class="review-comment ${archived ? 'archived' : 'pending'}" data-comment="${c.id}" data-anchor="${escapeHtml(c.anchor || "")}">
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
    const noun = pluralKomentara(n);
    const statusBadge = wantArchived
      ? `<span class="group-status applied">Done</span>`
      : `<span class="group-status pending">Pending</span>`;
    // Note: nema „Mark as done" dugmeta — Claude trenutno
    // jedini izvršava komentare (arhivira ih kroz drugi mehanizam,
    // npr. direktan write u RTDB ili out-of-band akcija). Ako se
    // ikad pojavi human-in-the-loop role-a koja arhivira ručno,
    // archive funkcija je u JS-u (archiveComments), samo treba
    // restore-ovati group footer markup ovde.
    const groupFooter = "";

    return `
      <div class="review-group ${wantArchived ? 'archived' : 'pending'}" data-anchor="${escapeHtml(group.anchor)}">
        <div class="review-group-header" data-anchor="${escapeHtml(group.anchor)}">
          <div class="anchor-row">
            <div class="anchor">${escapeHtml(group.anchor)}</div>
            ${statusBadge}
          </div>
          ${previewHTML}
          <div class="group-count">${n} ${noun}</div>
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
    document.querySelectorAll(".review-spotlight").forEach((el) => {
      el.classList.remove("review-spotlight");
    });
    // eslint-disable-next-line no-unused-expressions
    void target.offsetWidth;
    target.classList.add("review-spotlight");
    clearTimeout(window.__reviewSpotlightTimer);
    window.__reviewSpotlightTimer = setTimeout(() => {
      target.classList.remove("review-spotlight");
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

  // Per-comment Edit
  listEl.querySelectorAll("[data-action='edit']").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-comment");
      const comment = state.comments.find((c) => c.id === id);
      if (!comment) return;
      const anchorEl = document.querySelector(`[data-comment-id="${cssEscape(comment.anchor)}"]`);
      if (!anchorEl) {
        toast("Element no longer exists on the page.");
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
      if (!confirm("Delete comment permanently?")) return;
      btn.disabled = true;
      try {
        await deleteComment(id);
        toast("Obrisano.");
      } catch (err) {
        console.error("[review-mode] delete failed:", err);
        toast("Error: " + err.message);
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
        toast("Restored to active.");
      } catch (err) {
        console.error("[review-mode] restore failed:", err);
        toast("Error: " + err.message);
        btn.disabled = false;
      }
    });
  });

  // Note: nema „archive-group-btn" handler-a jer ne render-ujemo button.
  // archiveComments() funkcija ostaje u modulu — Claude (ili future
  // human-in-the-loop role-a) je može pozvati direktno preko window.__review
  // ili out-of-band Firebase write.
}

function renderActions(id, archived) {
  if (archived) {
    const restore = `<button data-comment="${id}" data-action="restore" class="restore-btn" title="Vrati u aktivne">&#8634; Vrati</button>`;
    const del = `<button data-comment="${id}" data-action="delete" class="delete-btn" title="Delete comment">&#10005; Delete</button>`;
    return restore + del;
  }
  const edit = `<button data-comment="${id}" data-action="edit" class="edit-btn" title="Uredi komentar">&#9998; Uredi</button>`;
  const del = `<button data-comment="${id}" data-action="delete" class="delete-btn" title="Delete comment">&#10005; Delete</button>`;
  return edit + del;
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

// Serbian plural for "komentar" — 1 komentar, 2-4 komentara, 5+ komentara,
// 11-14 komentara, 21 komentar (ends in 1 ali ne 11), itd.
function pluralKomentara(n) {
  if (n % 10 === 1 && n % 100 !== 11) return "komentar";
  return "komentara";
}

function toast(text) {
  const t = document.createElement("div");
  t.className = "review-toast";
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
