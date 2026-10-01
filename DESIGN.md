# Pharma Radar — Design System

Pharma Radar is a Chinese research reading site for pharmacy students and researchers. The English brand connects traditional Chinese medicine, natural products and AI drug discovery. Public pages are anonymous; saved reading lists remain in the browser.

## Visual direction

Research reading index using AIHOT's desktop sidebar and dense page structure, with Pharma Radar's English identity, navy ink and botanical accent. Home is a publication timeline; the library is a dense search interface; topics offer chronology and research-area organisation; detail is a research note. Serif is reserved for long-form research and the brief. No oversized promotional hero.

## Tokens

- Light: paper #F6F3ED, ink/navy #183047, botanical accent #526B4F, surface #FFFFFF, rule #D9DDD7.
- Dark: background #101D2A, surface #162637, ink #EEECE5, accent #ABC4A3. Semantic error, warning and success colours must remain distinguishable by text as well as colour.
- Chinese interface/list headings and body: Noto Sans SC; long-form research headings: Noto Serif SC; English brand/UI: IBM Plex Sans. WOFF2 files are served locally with unicode subsets and swap; system fallbacks remain usable.
- Base spacing 8px. Controls 4px radius, small panels 8px. Max page 1280px; long reading text 760px. Body 15–16px with 1.8 line height; headings 22/28/36px.
- Motion: 120–180ms for state changes, respect reduced motion. No decorative entrance animation.

## Layout and behaviour

- Desktop: 208px sticky sidebar and compact page header. Navigation: 导读、资料库、研究热点、研究简报、专题、阅读清单; support links and appearance below. Page max 1380px including an optional narrow index rail.
- Home: original publication chronology with sticky day headings, weekday, page-scoped counts, rail/nodes and date jumps. All/selected tabs retain each record's own selection and material labels. Display a compact hot strip only when real public data exists.
- Library: title/search, persistent desktop facets, active criteria, publication-date range, sorting and pagination. Mobile uses disclosures. Query links retain search/filter/date/sort state.
- Detail: original title and bibliographic information, source scope, research question/method/results/limitations, original publication link. AI score is internal editorial data.
- Topic: two featured subjects; default publication timeline with an alternate research-area view. Briefs retain citations and show their actual material window, generation time and revision. Saved records retain old browser entries and support saved/published sorting and unread filtering.
- Mobile: 4 primary bottom destinations (导读、资料库、专题、简报) and a 更多 menu. Touch targets at least 44px; no horizontal document overflow.
- Empty/error states explain what happened and offer clear/expand filters, open original or retry. Keyboard focus is visible; normal text contrast is at least 4.5:1.

## Research presentation

Research areas, focus topics, document forms, evidence stages and source origin are independent. A single paper can belong to several topics and evidence stages. Unknown is explicit; computed scores, source identity and research stage are not evidence quality grades. Missing methods or results must never be generated from a title or reference list.

## Decision log

2026-10-01: User approved English brand, academic editorial direction, stage-based facets plus featured topics, and simultaneous content/UI upgrade. Existing cloud plans, model budgets, public API identities and selection thresholds remain.

2026-10-01: User approved an AIHOT-like sidebar/timeline prototype. Publication date is primary, never collection date. Date-only rail: MM/DD then 发表; exact rail: MM/DD, HH:mm, 发表 on three separate lines. Dates without reliable clocks do not show fabricated times; unknown publication dates remain separate. Original precision and collection time live in expandable metadata. Legacy timelineAt, RSS/v1/MCP contracts remain unchanged.
