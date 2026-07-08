# AMA Quality Consulting - Shopify theme

DMEPOS (durable medical equipment) accreditation & compliance consulting site.
Theme files live at the repo root and sync two-way with Shopify via the GitHub
integration on this branch. `config/settings_data.json` is auto-written by
Shopify - rebase onto origin before pushing.

## Marketing strategy (follow this for ALL copy, offers, and design work)

Source of truth: `docs/dmepos-marketing-strategy-report.pdf` (deep research
report). Key directives:

- **Positioning:** "We help DMEPOS suppliers become enrollment-ready,
  survey-ready, and audit-defensible without guesswork, last-minute
  scrambling, or generic templates." Premium operator-level risk-reduction
  partner - not a template shop, not a generic consultancy.
- **Buyers are buying risk reduction**, speed, and confidence - not manuals.
  Fear points: losing/delaying Medicare billing privileges, failing a survey,
  CMS-855S mistakes, corrective action obligations.
- **2026 rule changes are the hook:** annual reaccreditation replaced the
  3-year cycle; new locations must be surveyed BEFORE accreditation;
  accreditation does not transfer after ownership changes.
- **CTAs must name the outcome** (ranked): "Schedule a Readiness Review",
  "Get Survey Ready", "Review My Medicare Enrollment", "Fix Your Corrective
  Action Plan". Avoid generic "Contact Us" / "Book a Free Consultation".
- **Offers by funnel stage:** cold = DMEPOS Readiness Checklist download;
  warm = Free DMEPOS Readiness Review; high-intent = Done-for-You
  Accreditation Package, Corrective Action Rescue, New Location/Ownership
  Change Package.
- **Visuals (ranked):** consultant + checklist/binder artifact; readiness
  checklist graphic; survey-ready office scene; CMS-855S document/timeline;
  stressed-to-relieved owner (retargeting only). Avoid generic corporate
  healthcare imagery.
- **Landing pages:** one page per offer, narrow and offer-specific. Planned:
  Readiness Review, CMS-855S Review, Corrective Action Rescue (all can use
  `templates/page.landing.liquid`).
- **Compliance guardrails:** never imply guaranteed approval/accreditation or
  any special relationship with CMS; FTC rules apply to testimonials. Say
  "we help you identify and correct readiness gaps", not "we guarantee".

## Style conventions

- Use plain hyphens, never em/en dashes (user preference).
- Brand: navy (#0b2545/#081b30), royal blue (#2f45f0), green (#2bd473);
  heart-check logo mark (see `snippets/illus-binder.liquid`, `assets/favicon.svg`).
- Illustrations are inline SVG in brand colors - no external stock images.
- Theme settings (phone, email, Calendly URL, Meta Pixel, Google Sheet
  webhook) live in `config/settings_schema.json` under "Contact & Booking"
  and "Tracking".
