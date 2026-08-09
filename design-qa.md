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
