# public/website/

Rendered HTML for the organization's web pages. Each file here is the public-mirror artifact of a `PAGE.md` in `content/web/pages/`. **Never authored directly**, these are rendered/exported from `content/`, or, as in the current state, captured verbatim from a live site that this repo is taking over as source-of-truth.

See `.claude/CONVENTIONS.md` §5 (canonical-vs-rendered) and §6 (channel taxonomy).

## Layout

```
public/website/
├── index.html                          ← /         (home)
├── services/index.html                 ← /services
├── clients/index.html                  ← /clients
├── projects/index.html                 ← /projects (listing)
├── projects/{slug}/index.html          ← /projects/{slug} (each case study)
├── contacts/index.html                 ← /contacts
├── about-us/index.html                 ← /about-us
└── blogs/index.html                    ← /blogs
```

The `{slug}/index.html` pattern (rather than `{slug}.html`) is used so the public mirror serves clean URLs without `.html` suffixes (`/services/` rather than `/services.html`).

## Provenance

Files in this folder were captured verbatim from `https://www.protastudios.com/...` on 2026-04-26 (Webflow's last published timestamp at capture: 2026-03-24). They reference the live Webflow CDN (`cdn.prod.website-files.com`) for images, fonts, and JS. To make the mirror self-contained, those dependencies need to be pulled local, see `content/web/sites/main-website/SITE.md` Open Questions.

## Public-mirror status

All 15 HTMLs below are listed in `work-setup/sync-public.yml` and get mirrored to `tnosugar/prota-studio-public` on every push to `main`. Pages config: source = main, path = / (set in BOOTSTRAP.md Step 2).

| URL on the public mirror | File served |
|---|---|
| `/` | `index.html` |
| `/services/` | `services/index.html` |
| `/clients/` | `clients/index.html` |
| `/projects/` | `projects/index.html` |
| `/projects/audubon/` | `projects/audubon/index.html` |
| `/projects/birdbuddy/` | `projects/birdbuddy/index.html` |
| `/projects/citi-ventures/` | `projects/citi-ventures/index.html` |
| `/projects/clorox-catpal/` | `projects/clorox-catpal/index.html` |
| `/projects/daikin-air/` | `projects/daikin-air/index.html` |
| `/projects/exelon/` | `projects/exelon/index.html` |
| `/projects/stix/` | `projects/stix/index.html` |
| `/projects/visa/` | `projects/visa/index.html` |
| `/contacts/` | `contacts/index.html` |
| `/about-us/` | `about-us/index.html` |
| `/blogs/` | `blogs/index.html` |

(Public-mirror base path will be `https://tnosugar.github.io/prota-studio-public/` until/unless a CNAME is configured. Absolute paths in the verbatim HTML, e.g. `<a href="/services">`, won't resolve correctly under the sub-path; flagged in `content/web/sites/main-website/SITE.md` Open Questions.)
