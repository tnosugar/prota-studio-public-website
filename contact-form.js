// Prota Studios — contact-form Firebase handler
//
// Loads as an ES module from any page that includes a <form id="contact-form">.
// On submit:
//   1. Reads all named inputs/selects/textareas under the form
//   2. Trims values, runs a honeypot-spam check, validates required fields
//   3. Pushes the submission to Realtime Database under CONTACTS_PATH
//   4. Shows a success message; on error shows a fallback ("email us directly")
//
// The form itself defines the field set — script is field-agnostic. Any
// <input type="text" name="something"> is captured automatically.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-database.js";

const cfg = window.PROTA_CONTACT_CONFIG || {};
const FALLBACK_EMAIL = "vsteward@gmail.com";

const form = document.getElementById("contact-form");
if (!form) {
  // No form on this page — script is a no-op
} else {

  const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
  const successEl = document.getElementById("contact-success");
  const errorEl = document.getElementById("contact-error");

  // --- Firebase init (only if ENABLED) ----------------------------------
  let db = null;
  if (cfg.ENABLED && cfg.FIREBASE_CONFIG) {
    try {
      const app = initializeApp(cfg.FIREBASE_CONFIG);
      db = getDatabase(app);
    } catch (e) {
      console.error("Firebase init failed:", e);
    }
  } else {
    console.warn("Contact form: Firebase config not enabled. Form submissions will fall back to mailto.");
  }

  // --- Helpers ----------------------------------------------------------
  function showSuccess() {
    form.hidden = true;
    if (successEl) {
      successEl.hidden = false;
      successEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function showError(msg) {
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
      errorEl.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      alert(msg);
    }
  }

  function clearError() {
    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = "";
    }
  }

  function readPayload() {
    const data = {};
    const fields = form.querySelectorAll('input, select, textarea');
    for (const f of fields) {
      if (!f.name) continue;
      if (f.type === 'submit' || f.type === 'button') continue;
      const v = (f.value || "").trim();
      data[f.name] = v;
    }
    return data;
  }

  function validate(p) {
    // Honeypot: a few common field names. Different pages use different conventions.
    // If any of these has a value, treat as spam silently.
    if (p._honey || p["company-website"] || p.honeypot) return { spam: true };

    if (!p.name) return { msg: "Please enter your name." };
    if (!p.email) return { msg: "Please enter your email." };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
      return { msg: "That email does not look quite right. Check it once more." };
    }
    if (!p.company) return { msg: "Please enter your company." };
    if (!p.role) return { msg: "Please enter your role." };
    if (!p.stage) return { msg: "Please select a team stage." };
    if (!p.validating) return { msg: "Tell us what you are validating." };
    return null;
  }

  function fallbackMailto(payload) {
    const subj = encodeURIComponent(`Prota Studios contact: ${payload.company || payload.name || "(unknown)"}`);
    const body = encodeURIComponent(
      Object.entries(payload)
        .filter(([k]) => k !== '_honey')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    );
    window.location.href = `mailto:${FALLBACK_EMAIL}?subject=${subj}&body=${body}`;
  }

  // --- Submit handler ---------------------------------------------------
  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    clearError();

    const payload = readPayload();
    const err = validate(payload);
    if (err) {
      if (err.spam) {
        // Silently pretend success for bots
        showSuccess();
        return;
      }
      showError(err.msg);
      return;
    }

    if (!db) {
      // Firebase not configured — fall back to mailto
      fallbackMailto(payload);
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.originalText = submitBtn.textContent;
      submitBtn.textContent = "Sending…";
    }

    try {
      // Augment payload with metadata that helps spam triage and routing
      const record = {
        ...payload,
        userAgent: navigator.userAgent,
        clientTime: new Date().toISOString(),
        serverTime: serverTimestamp(),
        sourcePage: window.location.pathname,
      };
      delete record._honey;
      delete record["company-website"];
      delete record.honeypot;

      const path = cfg.CONTACTS_PATH || "contacts";
      const newRef = push(ref(db, path));
      // Lazy-import set so we can use the return ref
      const { set } = await import("https://www.gstatic.com/firebasejs/10.12.4/firebase-database.js");
      await set(newRef, record);

      showSuccess();
    } catch (e) {
      console.error("Contact submit failed:", e);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = submitBtn.dataset.originalText || "Send";
      }
      showError(`Something went wrong sending the form. Email us directly at ${FALLBACK_EMAIL}.`);
    }
  });
}
