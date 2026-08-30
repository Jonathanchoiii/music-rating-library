# RecordShelf 聆听指南阶段 A — Design QA

## Evidence

- Source visual truth: `/var/folders/pf/8y1pxs4n6sd73dxwq3xhk3_m0000gn/T/codex-clipboard-09ed8e56-9be6-436d-b9c2-135b7bd1ec83.png`
- Rendered mobile implementation: `/Users/jonathanchoiii/Documents/AI coding 项目们/music-rating-library/qa-listening-guide-mobile.png`
- Rendered desktop implementation: `/Users/jonathanchoiii/Documents/AI coding 项目们/music-rating-library/qa-listening-guide-desktop.png`
- Combined comparison evidence: `/Users/jonathanchoiii/Documents/AI coding 项目们/music-rating-library/qa-listening-guide-comparison.png`
- Local route: `http://127.0.0.1:4175/releases/release-import-neodb-n4v39m?view=grid&from=library`

## Viewports and normalization

- Source: 1080 × 1439 px, framed mobile marketing reference.
- Mobile implementation: 484 × 900 CSS px at device scale 1, unframed RecordShelf drawer.
- Desktop implementation: 1000 × 800 CSS px at device scale 1.
- Comparison: both mobile images were placed into equal-width columns and scaled proportionally. The source phone frame and marketing headline are intentionally retained only as visual-reference context; comparison focuses on editorial hierarchy, reading density and music-background storytelling.
- State: release detail open, cached guide ready; collapsed summary checked on mobile and desktop; expanded seven-section article and source list checked separately.

## Required fidelity surfaces

- Fonts and typography: passed. The guide reuses RecordShelf’s existing system stack, 21/20 px section heading, 15 px article heading and 14–15 px body with 1.82 line height. Hierarchy remains readable without introducing the reference’s unrelated display treatment.
- Spacing and layout rhythm: passed. The guide sits directly below the listening timeline and above duplicate correction. Summary, tracks, article sections and sources follow the drawer’s existing divider rhythm; controls retain at least 44 px targets on narrow screens.
- Colors and visual tokens: passed. Accent purple, warm-white surface, muted metadata and existing borders reuse project tokens. The dark cinematic reference was not copied because the user explicitly requested consistency with RecordShelf.
- Image quality and asset fidelity: passed. No new decorative assets, fake artwork or substitute icons were introduced. Existing Phosphor icons and the real album cover remain in use.
- Copy and content: passed. The pilot uses the release-language title, seven requested sections, source links, restrained UGC wording and no unsupported award claim. The UI clearly labels the pilot-only state for other albums.

## Full-view comparison evidence

The combined sheet confirms that both designs establish a clear music identity, an editorial introduction and a long-form reading path. The implementation intentionally translates those principles into the existing RecordShelf drawer rather than reproducing the reference’s phone frame, dark gradient, play/favorite/share controls or cover-led hero.

## Focused region comparison evidence

The mobile guide capture was inspected at native 484 × 900 pixels. The title, timestamp, summary, recommended tracks, expand action and following duplicate section remain legible and correctly ordered. The desktop capture verifies that the same hierarchy uses the wider drawer without excessive line length or horizontal overflow.

## Interaction and runtime checks

- Cached guide loaded without an automatic network generation action.
- Expand/collapse state worked and exposed all seven sections.
- Source disclosure opened and exposed 9 external source links.
- Update action completed and retained a ready guide.
- Empty pilot and non-pilot explanatory states are implemented.
- Console errors checked after load, expand, source disclosure and update: none.
- Automated tests: 114 passed.
- Production Web build and desktop-client build: passed.

## Findings

No actionable P0, P1 or P2 findings remain. The most visible difference from the reference—the light editorial treatment—is an intentional constraint from the existing RecordShelf design system and the user’s instruction, not design drift.

## Comparison history

- Pass 1: combined source/implementation comparison found no P0/P1/P2 mismatch after normalizing both images to equal-width columns. No visual fix was required after the comparison.

## Follow-up polish

- P3: when full-library generation is implemented, consider a compact “资料有更新” marker next to the existing update control rather than adding another status card.

final result: passed

---

# RecordShelf 艺人详情流派标签 — Design QA

## Evidence

- Source visual truth: `/var/folders/pf/8y1pxs4n6sd73dxwq3xhk3_m0000gn/T/codex-clipboard-45554154-a9f7-472e-9aa2-7683e0e1a0b8.png`
- Target route: `http://127.0.0.1:4176/artists?view=grid&artist=raw-doja+cat`

## Required fidelity surfaces

- Container: passed. The genre fact no longer renders as one full-width gray panel; its outer surface is transparent.
- Chips: passed. Each genre uses an independent `#efefec` low-contrast chip with 11px muted text, 3px × 8px padding, 6px radius and a minimum 20px height.
- Flow: passed. Chips keep their labels on one line and the collection wraps naturally with a 6px gap, so long artist profiles remain readable without horizontal overflow.
- Scope: passed. Birth, location, region, type and the artist biography retain their existing RecordShelf information hierarchy.

## Verification

- Focused artist-detail contract tests: 9/9 passed.
- Production Web build: passed; only the existing large-chunk warning remains.
- `git diff --check`: passed before delivery.
- The fresh local browser process did not contain the cached Doja Cat public-profile payload, so the data-dependent visual state could not be reproduced there. The rendered contract was therefore verified through the component source, focused CSS assertions and production build rather than by claiming a live-data screenshot.

final result: passed

---

# RecordShelf 艺人主页链接状态与跳转 — Design QA

## Evidence

- Verified local route: `http://127.0.0.1:4173/artists?view=grid&artist=raw-kiiikiii`
- Desktop capture: `/private/tmp/recordshelf-artist-platform-links-desktop.png`
- Mobile capture: `/private/tmp/recordshelf-artist-platform-links-mobile.png`
- Interaction reference: the existing release-detail platform icon row and the artist-detail annotation supplied for KiiiKiii.

## Required fidelity surfaces

- Connected state: passed. A saved Apple Music artist URL renders as an accent-highlighted anchor, opens the exact artist homepage in a new tab and retains an explicit accessible label.
- Missing state: passed. Spotify and YouTube Music without saved links remain muted, disabled and non-clickable; they do not masquerade as usable navigation.
- Editing boundary: passed. The pencil control remains visually separate and is still the only entry for editing all artist homepage URLs.
- Media boundary: passed. The dynamic-hero control remains a separate action and does not conflate artist-page navigation with media retrieval.
- Responsive layout: passed. Desktop and 390 × 844 mobile captures keep the icon row below the artist summary with no horizontal overflow or control collision.
- Persistence: passed. Reloading the stable artist route restores the connected Apple Music state from the shared Web/Mac artist profile.

## Interaction and runtime checks

- DOM inspection confirmed Apple Music is an external link with `target="_blank"` and `rel="noopener noreferrer"`.
- DOM inspection confirmed missing Spotify and YouTube Music controls expose disabled states.
- Focused artist-detail platform-link contract checks passed; the production Web build passed; `git diff --check` passed.
- Three unrelated pre-existing contract/fixture drifts remain outside this change: two hero-tuning assertions and one artist-profile motion fixture expectation.
- Browser error log contained one stale dynamic-import error from 2026-08-16; the current 2026-08-17 desktop and mobile renders completed successfully with no new runtime error observed.

## Findings

No actionable P0, P1 or P2 finding remains for the saved-link highlight and navigation behavior.

final result: passed

---

# RecordShelf 艺人详情公开资料与关闭交互 — Design QA

## Evidence

- Annotated UI state: `http://127.0.0.1:4176/artists?artist=raw-doja+cat&view=grid`
- Reference screenshots: the three browser annotations supplied for the artist-detail backdrop, identity heading and introduction module.
- Real research request: Doja Cat resolved to the exact MusicBrainz artist identity and returned a verified public profile with birth date, birthplace, country, type, genres and a Chinese Wikipedia introduction.
- Shared result: the researched profile was written under the stable `raw-doja+cat` artist key in the Web/Mac shared local state.

## Viewports and normalization

- The change preserves the existing 690 px desktop artist drawer and full-width mobile drawer.
- No new visual system or source-logo row was introduced. Structured facts appear in the existing vertical section rhythm directly below “艺人介绍”.

## Required fidelity surfaces

- Backdrop behavior: passed. Only clicking the backdrop itself closes; clicks inside the drawer do not bubble into a close action.
- Identity hierarchy: passed. The redundant “原始艺人署名” eyebrow is absent; the artist name, aliases and local collection summary retain the established hierarchy.
- Manual research: passed. The sparkle action is the only trigger, enters a visible research state and renders only verified facts returned by the local research service.
- Public facts: passed. Person profiles support birth date and birthplace; group profiles support formed date, origin and verified member relations. Unknown values remain absent.
- Persistence: passed. Research results merge into the stable artist profile without replacing exploration or release-view preferences.

## Interaction and runtime checks

- Real POST request against the active local service returned a ready Doja Cat profile and persisted it into the shared local state.
- MusicBrainz request interval and exact-name ambiguity rules were exercised by automated tests.
- Wikidata sitelink → Chinese Wikipedia → English Wikipedia fallback was exercised by automated tests.
- Artist-detail source contract verifies backdrop-only close, removal of the redundant eyebrow and exactly one manual research action.
- Automated tests: 241 passed.
- Production Web build: passed.
- `git diff --check`: passed.

## Browser automation limitation

The current Codex session did not expose the Browser/Chrome control interface, so no new automated click recording or screenshot was fabricated. The same route was kept available for manual inspection, while interaction semantics were verified through the rendered component contract, real local HTTP request and persisted shared-state result.

## Findings

No actionable P0, P1 or P2 finding remains for the three annotated issues.

final result: passed

---

# RecordShelf 艺人详情「我的收录」双视图 — Design QA

## Evidence

- Product reference: the existing RecordShelf release list and cover-grid patterns, used inside the established artist-detail drawer.
- Verified local route: `http://127.0.0.1:4176/artists?artist=raw-doja+cat&view=grid`
- Desktop comparison state: list view and cover-grid view captured at the same viewport, filter and artist state.
- Mobile state: 390 × 844 CSS px, cover grid captured with the same artist and collection filter.

## Viewports and normalization

- Desktop: existing app viewport, 690 px artist drawer, three-column cover grid.
- Mobile: 390 × 844 CSS px, full-width artist drawer, two-column cover grid.
- Both views reuse the same release dataset, `全部 / LP / EP / Single / 未分类` filter state and release-detail navigation.

## Required fidelity surfaces

- View control: passed. The two-icon segmented control matches RecordShelf's existing compact outline controls and exposes only list and cover-grid modes.
- List view: passed. It preserves the previous compact cover, title, type/date, rating and forward affordance.
- Cover grid: passed. Covers lead the hierarchy; title, type/date and rating remain readable without introducing a new card style.
- Desktop responsiveness: passed. The grid resolves to three equal columns with no horizontal overflow.
- Mobile responsiveness: passed. At 390 px the grid resolves to two equal 173 px columns inside a 358 px content width; all cards remain within the drawer bounds.
- Accessibility: passed. Both controls expose descriptive labels and mutually exclusive `aria-pressed` states.
- Persistence: passed. `releaseView` is stored per stable artist profile ID and unknown values normalize back to list.

## Interaction and runtime checks

- List → cover grid → list switching worked without navigation or filter reset.
- The active icon and `aria-pressed` state updated correctly in both directions.
- Desktop and mobile layouts were compared in the same artist state.
- Automated tests: 233 passed.
- Production Web build: passed.
- `git diff --check`: passed.

## Findings

No actionable P0, P1 or P2 findings remain. The feature intentionally excludes wall and shelf modes from Artist Detail so the local artist collection remains compact and consistent with the established drawer interaction model.

final result: passed

---

# RecordShelf 艺人详情主页入口与单艺人素材请求 — Design QA

## Evidence

- Verified local route: `http://127.0.0.1:4176/artists?view=grid&artist=raw-kiiikiii`
- Existing RecordShelf artist-detail drawer remains the geometry and interaction reference.
- Empty-media reference state: KiiiKiii uses the two collected EP covers as the hero fallback.

## Required fidelity surfaces

- Hero fallback: passed. No artist image or motion asset still resolves to the existing release-cover collage without a blank or broken-image state.
- Platform tools: passed. Apple Music, Spotify and YouTube Music use compact icon controls in the identity block; saved links open the exact artist homepage, while missing links open the inline editor.
- Media request: passed. One dedicated control requests only the current artist's Apple Music public image or editorial motion visual. It does not scan the library on drawer open.
- Visual priority: passed. Local motion WebP, cached artist image and album collage are mutually exclusive and ordered from richest verified source to local fallback.
- Data boundary: passed. Links and media status persist in shared `artistProfiles`; no private URL or cached media is bundled into Git.
- Responsive structure: passed in the browser. The editor remains inside the established vertical drawer and collapses to one-column fields below 750 px.

## Interaction and runtime checks

- Missing platform icons and the edit icon open the same exact-link editor.
- Invalid provider URLs remain unsaved and expose an inline error.
- A media request without an Apple Music artist URL opens the editor instead of making a blind search request.
- The backdrop retains click-to-close behavior; controls inside the drawer do not close it.
- Desktop runtime check: the KiiiKiii route rendered the release-cover fallback, the three platform controls and the single-artist media request together; opening “编辑艺人主页链接” exposed Apple Music、Spotify 与 YouTube Music exact-link fields without leaving the drawer.
- Mobile runtime check: at 390 × 844 CSS px the drawer width was 390 px, the editor width was 358 px, and the document scroll width remained 390 px, so the form introduced no horizontal overflow.
- Automated focused tests and production build results are recorded in the delivery note for this change.

## Findings

No deliberate source badge row or automatic full-library media scan was introduced. The only external-source affordances are compact artist-homepage icons and the explicit single-artist media action requested for this phase.

final result: passed

---

# RecordShelf 艺人详情阶段 A — Design QA

## Evidence

- Source visual truth: `/var/folders/pf/8y1pxs4n6sd73dxwq3xhk3_m0000gn/T/codex-clipboard-bb66d6bc-3643-4ae4-a537-e1d8e2fc9659.png`
- Desktop capture: `/private/tmp/recordshelf-artist-detail-desktop.png`
- Mobile capture: `/private/tmp/recordshelf-artist-detail-mobile-top.png`
- Combined comparison: `/private/tmp/recordshelf-artist-detail-comparison.png`
- Verified local route: `http://127.0.0.1:4175/artists?view=grid&artist=artist-1a00ef05-9e19-4a2e-ab86-3c976832184e`

## Viewports and normalization

- Desktop implementation: 1365 × 900 CSS px.
- Mobile implementation: 390 × 844 CSS px.
- The source is an existing RecordShelf album-detail drawer. The comparison therefore treats drawer width, hierarchy, spacing, controls and backdrop behavior as the fidelity targets while replacing album-specific information with artist-specific information.

## Required fidelity surfaces

- Drawer geometry: passed. Desktop uses the same 690 px right-side drawer pattern as the album detail; mobile becomes a full-width surface.
- Information flow: passed. All artist content remains one vertical column on desktop and mobile, without a separate wide-screen dashboard or horizontal carousel.
- Header and hero: passed. The header retains the existing title/close interaction. Phase A uses a restrained collage made only from locally collected release covers, followed by the artist name, aliases and collection summary.
- Source controls at the original Phase A checkpoint: superseded. The current specification now exposes compact Apple Music, Spotify and YouTube Music artist-homepage icons plus one explicit Apple Music media request control; see the current QA section above.
- Collection: passed. `全部 / LP / EP / Single / 未分类` filters update the vertical release list; opening a release and closing it returns to the same artist detail.
- Exploration: passed. The switch persists locally. It does not fabricate unseen works or imply that external catalogs have already been fetched.
- Collaboration: passed. Only exact collaborators already evidenced by local shared releases are shown and remain navigable.
- Responsive behavior: passed. The 390 px view keeps consistent inset spacing, 44 px interaction targets and no obvious horizontal overflow.

## Interaction and runtime checks

- Direct artist route resolved to the intended artist identity.
- Collection filtering worked and preserved the detail surface.
- Release detail navigation retained the artist return target.
- Closing a release returned to the artist detail; closing the artist detail returned to the artist index/workspace.
- Exploration preference survived reload through the shared local profile state.
- No automatic external research, image download or dynamic media request was triggered.
- Automated tests: 232 passed.
- Production Web build: passed.
- `git diff --check`: passed.

## Findings

No actionable P0, P1 or P2 findings remain. The deliberate visual difference from entertainment-first references is the use of RecordShelf's existing warm-white drawer, compact controls and local-data-first hierarchy. Public biography, high-resolution artist photography, unexplored discography and motion media remain explicit manual-request follow-ups rather than inferred Phase A content.

final result: passed
