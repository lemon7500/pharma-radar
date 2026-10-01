# Pharma Radar — Design System

Pharma Radar is a Chinese research reading site for pharmacy students and researchers. The English brand connects traditional Chinese medicine, natural products and AI drug discovery. Public pages are anonymous; saved reading lists remain in the browser.

## Visual direction

Academic editorial: a horizontal English masthead, a clear serif heading hierarchy, fine rules and compact research records. Home is an editorial introduction; the library is a search interface; a topic is a structured index; detail is a research note. Avoid decorative dashboards, large pill navigation and interchangeable rounded cards.

## Tokens

- Light: paper #F6F3ED, ink/navy #183047, botanical accent #526B4F, surface #FFFFFF, rule #D9DDD7.
- Dark: background #101D2A, surface #162637, ink #EEECE5, accent #ABC4A3. Semantic error, warning and success colours must remain distinguishable by text as well as colour.
- Chinese headings: Noto Serif SC; body: Noto Sans SC; English masthead/UI: IBM Plex Sans. WOFF2 files are served locally with unicode subsets and swap; system fallbacks remain usable.
- Base spacing 8px. Controls 4px radius, small panels 8px. Max page 1280px; long reading text 760px. Body 15–16px with 1.8 line height; headings 22/28/36px.
- Motion: 120–180ms for state changes, respect reduced motion. No decorative entrance animation.

## Layout and behaviour

- Desktop: full-width masthead above a centred page. Primary navigation: 导读、资料库、专题、研究简报、阅读清单. Support links and appearance live in the secondary navigation/footer.
- Home: editorial main column with selected research and explicitly labelled latest records; narrow topic index rail. Never call latest records selected.
- Library: title/search, independent facets, active criteria, results and pagination. Facets combine across dimensions; mobile uses a disclosure filter panel.
- Detail: original title and bibliographic information, source scope, research question/method/results/limitations, original publication link. AI score is internal editorial data.
- Topic: two featured cross-cutting subjects and research-stage sections. Briefs retain source citations. Saved records retain old browser entries.
- Mobile: 4 primary bottom destinations (导读、资料库、专题、简报) and a 更多 menu. Touch targets at least 44px; no horizontal document overflow.
- Empty/error states explain what happened and offer clear/expand filters, open original or retry. Keyboard focus is visible; normal text contrast is at least 4.5:1.

## Research presentation

Research areas, focus topics, document forms, evidence stages and source origin are independent. A single paper can belong to several topics and evidence stages. Unknown is explicit; computed scores, source identity and research stage are not evidence quality grades. Missing methods or results must never be generated from a title or reference list.

## Decision log

2026-10-01: User approved English brand, academic editorial direction, stage-based facets plus featured topics, and simultaneous content/UI upgrade. Existing cloud plans, model budgets, public API identities and selection thresholds remain.
