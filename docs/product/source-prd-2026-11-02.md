# Selective Designer: Product Requirements Document

Nov 2, 2026 · @Harold Martin

## Summary

Selective Designer lets a selections coordinator place product and material options into an architect's render, re-render on four image models, and compare the results as tracked forks. Version 1 is a desktop web app for one first user, whose real projects will validate it before any SaaS launch.

| Decision | Version 1 |
| --- | --- |
| Starting point | The image the user uploads, with no separate base step |
| Image models | Krea 3, FLUX 3 Image, Ideogram 4.5 and Riverflow; every render runs on all four |
| Results | Each model's full output, displayed as returned |
| Unintended changes | A checker model warns but never blocks or alters a result |
| Masking | A separate masking model creates selectable regions |
| Accuracy bar | Right style and material, not an exact product match |
| Output | 2K image download, with no watermark or label |
| Usage cost | Paid by the product owner during validation, monitored and capped |

## Problem and first user

General AI image generators often change parts of a render unrelated to the requested edit, which makes options hard to compare. The first user is a selections coordinator and design consultant who chooses plants, lighting, materials and hardware to support an architect's design.

- **Input:** flat, simple 3D renders from the architect, mostly large-scale shots.
- **References:** product photos, room photos and material swatches collected as mood boards.
- **Output:** high-fidelity visuals for clients, often with several options for one element.
- **Accuracy:** images must convey the right style and material. The exact product is confirmed elsewhere.

The first user has real projects available for validation. Their visual work has no set time budget today.

## Goals and scope

Version 1 succeeds if the first user spends less time per project and targeted edits leave unrelated areas intact. Numeric targets come after the first measurements, because no baseline exists yet.

| Measure | How it's measured | Target |
| --- | --- | --- |
| Time saved | Time per project compared with the first user's current process | Set after timing a first project |
| Edit precision | Checker warnings and first-user review across rounds of edits | Set after the model evaluation |

**Not in version 1:**

- Native CAD files and render passes
- Revised renders from the architect
- Consistency across views of a project
- Perspective and layering controls
- Link, browser extension and board imports
- Price, lead time and approval status
- PDFs, share links and client feedback
- Dedicated scene relighting controls
- Billing, teams and roles
- Mobile apps

## Core concepts

Every result is a fork in a per-image render tree, and the uploaded image is its root.

| Concept | Definition |
| --- | --- |
| Project | Holds many images and one shared mood board |
| Mood board | A project's collection of items, grouped by category |
| Item | A product, an extract from a room photo or a material swatch, with a category, name, vendor and product link |
| Base image | The flat image the user uploads, kept unchanged as the root of its render tree |
| Region | A selectable area produced by the masking model or marked by the user |
| Edit set | The placements, replacements, removals, material changes, light states and prompt for the next render |
| Render | One edit set sent from one parent image to every enabled model |
| Fork | One model's full output from a render, stored with everything used to make it |
| Scheme | A name the user gives a fork so it can be found and compared later |

## Primary user flow

The user uploads an image, builds an edit from the mood board, renders on every model and continues from the best fork.

&#91;embedded content: core loop · 4 image models, 1 checker, 1 decision\]

Forks never merge, so a different mix of options means another render from the chosen fork.

## Functional requirements

All requirements below are in version 1.

### Projects and mood board

| ID | Requirement |
| --- | --- |
| MB-1 | A project holds many images and one shared mood board. |
| MB-2 | The user adds images by file upload or clipboard paste. |
| MB-3 | Each item stores a category, name, vendor and product link. |
| MB-4 | The product removes the background from a product photo so it can be placed on the canvas. |
| MB-5 | The user extracts an item from a room photo by clicking it, drawing a box or describing it. |
| MB-6 | Material swatches are stored as items and used for wholesale edits. |

### Base image and regions

| ID | Requirement |
| --- | --- |
| BI-1 | The user uploads a flat image as the base image. |
| BI-2 | The base image is stored unchanged and becomes the root of its render tree. |
| BI-3 | A separate masking model segments the base image after upload. |
| BI-4 | The user selects regions by clicking an object, drawing a box or brush, confirming automatic detections or describing them in words. |
| BI-5 | When the user continues from a fork, the masking model segments that fork so regions match the image on screen. |

### Canvas and edits

| ID | Requirement |
| --- | --- |
| CE-1 | The user drags items from the mood board onto the current image. |
| CE-2 | The user can move, resize, rotate and duplicate a placed item. |
| CE-3 | The user can replace an existing object by assigning an item to its region. |
| CE-4 | The user can remove an object by selecting its region. |
| CE-5 | The user can change a whole region's material with a swatch or written instruction. |
| CE-6 | The user can turn a placed light on or off. |
| CE-7 | The user can request a whole-image edit with a written prompt and optional reference photo, including converting a CAD render to photoreal. |
| CE-8 | One render can include several edits. |
| CE-9 | The product warns when a placed item is smaller than the reliable size found in the evaluation. |

### Rendering and forks

| ID | Requirement |
| --- | --- |
| RF-1 | Each render runs on every enabled model, with no model selection at render time. |
| RF-2 | Each model returns one fork, displayed as soon as it's ready. |
| RF-3 | The product displays and stores each model's full output as returned, with no compositing or pixel locking. |
| RF-4 | A failed model shows an error and a retry for that model, without blocking the others. |
| RF-5 | The user can batch several options for one placement, with one render per option. |
| RF-6 | Any fork can become the parent of the next render. |
| RF-7 | The user can browse the render tree, return to any fork and name a fork as a scheme. |
| RF-8 | Each fork records its parent, base image, source images, items, placements, regions, final prompt, model, version, settings, cost and checker result. |

### Checker

| ID | Requirement |
| --- | --- |
| CK-1 | A checker model compares each fork with its parent and reports changes outside the requested edits. |
| CK-2 | A fork with a reported change shows a warning and the affected areas. |
| CK-3 | Warnings never block, hide, change or rerun a fork. |
| CK-4 | Glow around a placed light that is on does not count as an unintended change. |
| CK-5 | Forks display without waiting for the checker. |

### Compare and download

| ID | Requirement |
| --- | --- |
| CD-1 | The user can compare two forks side by side. |
| CD-2 | The user can view the forks from a render or batch in a grid. |
| CD-3 | The user can download any fork at 2K, with no watermark or label. |

### Account and usage

| ID | Requirement |
| --- | --- |
| AU-1 | One user logs in and owns all projects. |
| AU-2 | The product logs the cost of every model call. |
| AU-3 | New renders stop when usage reaches a configurable cap. |

## Model integration

All four image models offer ways to target an area and use reference images, but each expresses them differently, so each needs its own adapter. Everything in this table comes from vendor documentation and is untested.

| Model | Target area | Reference images | 2K behavior | Preservation claim | Price at 2K |
| --- | --- | --- | --- | --- | --- |
| [Krea 3](https://www.krea.ai/docs/developers/krea-3/overview.md) | `regions` boxes, plus `regional_edit` | Up to 8 | Exact pixel dimensions not guaranteed | `regional_edit` keeps the rest exact | $0.06 base; about $0.17 with a 2K scene, 1K reference and box |
| [FLUX 3 Image](https://docs.bfl.ml/flux_3/flux3_image_bounding_boxes.md) | Boxes written into the prompt, as keep, move, new and remove rows | [Up to 10](https://docs.bfl.ml/api-reference/utility/generate-an-image-with-flux-3.md) | `match_input` keeps the source size, up to 4 MP | Areas outside boxes usually stay identical; boxes don't clip | Not confirmed |
| [Ideogram 4.5](https://developer.ideogram.ai/api-reference/images/precise-edit/ideogram-4-5) | `mask` or `context_window` | Up to 4, or 3 with a mask | Output matches input size; whole-image edits cap at about 4 MP | Unchanged pixels are copied exactly | [$0.008 to $0.22](https://ideogram.ai/models/4.5/) by quality |
| [Riverflow 2.5](https://www.riverflow.ai/developers/api) | `mask_regions` | `reference_asset_ids`; shown on parent-image edits, not in the uploaded-image example | `resolution: 2K` | None found | Credits with no fixed cash value; 30 per edit in the docs' example |

**Integration requirements:**

- **Adapter:** Each adapter turns an edit set into that model's request and returns one image, its version, settings and cost.
- **Placement:** Boxes don't carry rotation. The evaluation compares a box plus reference with a rough composite of the item at its placed position.
- **Whole-image edits:** Krea runs without `regional_edit`, and Ideogram runs without a mask or `context_window`.
- **Lights:** The target area for a light that is on includes the surfaces it illuminates.
- **FLUX 3 Image:** `grounding` is set to `false`. The adapter builds the element table from the regions the masking model finds.
- **Riverflow:** Assets upload through one service brand, using a 2.5 model key such as `riverflow-2.5-pro-high`. Credits are debited on acceptance and refunded once if generation fails.
- **Masking model:** [SAM 3 on fal](https://fal.ai/models/fal-ai/sam-3/image/llms.txt) is the leading candidate, with text, point and box prompts at $0.005 per request. It still needs testing on CAD renders.
- **Checker model:** Not yet selected. The evaluation compares a pixel-difference map with a vision model's review.

## Non-functional requirements

The product must stay usable when one model is slow or fails, and every output must outlast its provider's link.

- **Platform:** Desktop web app only.
- **Background work:** Renders run in the background, and the interface stays usable while forks arrive. Latency targets are set after the evaluation.
- **Storage:** The product copies every output to its own storage, because provider links can expire.
- **Model changes:** Adding, disabling or replacing a model takes one adapter and a configuration change.
- **Cost:** One render costs at least $0.39: about $0.17 for Krea 3 and $0.22 for Ideogram 4.5 at high quality. FLUX 3 Image, Riverflow and the checker add to that, and masking adds $0.005 per request.
- **Data handling:** Client renders go to model providers under standard API terms, with FLUX 3 Image's web grounding turned off. Krea's zero data retention is enterprise-only, so version 1 doesn't assume it.

## Model evaluation

Run every model on the first user's real projects before building the full interface, because the hardest requirements are still unproven. The first user rates the results, producing a scorecard for each model.

| Test | Example | Question |
| --- | --- | --- |
| Whole-image conversion | CAD render to photoreal, with a prompt and reference photo | Does the design survive? |
| Perspective | Sconce on an angled wall | Does the item match the scene without perspective controls? |
| Occlusion | Tree behind a fence | Does the item sit correctly behind existing objects? |
| Small items | Door handle in a large-scale shot | What is the smallest legible size for each model? |
| Placement input | Rotated item, as a box plus reference and as a rough composite | Which input best respects position, size and rotation? |
| Duplicates | One sconce along a row of columns | Do the copies stay consistent? |
| Replace and remove | Swap or delete an existing fixture | Does the result look natural? |
| Wholesale material | New cladding across a masked facade | Does the material stay in its region and follow the geometry? |
| Fixture lighting | Sconce turned on | Does the glow look believable and stay nearby? |
| Multi-round drift | Five edits in sequence | How much do unrelated areas change across rounds? |
| Masking | Click, box, text and automatic detection on flat CAD renders | Are the regions usable on low-detail images? |
| Checker | Forks with known unintended changes | Does it catch real changes without too many false warnings? |

The scorecards decide which models stay enabled and set the edit precision target.

## Risks

The largest risk is that accepting full outputs leaves the core promise, changing only what was asked, dependent on model behavior.

| Risk | Why it matters | Response |
| --- | --- | --- |
| Unrelated areas drift | Outputs aren't locked, so the original problem can return and build up across rounds | Measure drift in the evaluation, warn through the checker, and revisit compositing if the first user rejects the results |
| Small items don't render | Work is mostly large-scale shots, and [FLUX's docs](https://docs.bfl.ml/flux_3/flux3_image_bounding_boxes.md) say new elements in boxes near 40 × 25 pixels often didn't appear | Measure per model, warn below the limit, and revisit 2K if needed |
| Conversion alters the design | No approval gate exists, so altered geometry can carry into later rounds | Warn through the checker and compare the fork with its parent |
| Review load | Each render returns 4 forks, and a batch of 4 options returns 16 | Use the grid view and disable weak models after the evaluation |
| Cost is hard to predict | Riverflow's credits have no fixed cash value, and FLUX's 2K price isn't confirmed | Log cost per model and enforce the usage cap |
| Riverflow fits awkwardly | Its API is organized around brands and products, and it targets ecommerce creative | Use one service brand and let the scorecard decide whether it stays enabled |
| Revised renders cause rework | Version 1 leaves them out, so users must place items again | Ask how often renders change, and store placements so replay can be added later |
| Models change quickly | New versions can change results between renders | Record the model version on every fork and keep vendor logic in adapters |

## Open questions

- [ ] **Base image:** Is photoreal conversion an optional whole-image render, as written here, or are uploads already photoreal so no conversion is needed?
- [ ] **Time baseline:** "No set budget" is recorded as no existing time budget. Can the first user time one project using their current process?
- [ ] **Small items:** Must door handles and similar items read clearly in large-scale shots? If so, is 2K still enough?
- [ ] **Riverflow version:** This PRD uses 2.5, the current version. Should the evaluation also include 2.0, the version originally linked?
- [ ] **Masking on forks:** BI-5 extends masking from the base image to any fork the user continues from. Is that the intended behavior?
- [ ] **Masking and checker models:** Which models ship, and does SAM 3's license permit commercial use?
- [ ] **Usage cap:** What spending limit applies during validation?
- [ ] **Revised renders:** How often do renders change during selections?
- [ ] **Before SaaS:** What do provider data terms allow, and what rights are needed to use vendor product images?

## Sources

- [Krea 3 product page](https://www.krea.ai/krea-3)
- [Krea 3 API overview](https://www.krea.ai/docs/developers/krea-3/overview.md)
- [FLUX 3 Image product page](https://bfl.ai/models/flux-3-image)
- [FLUX 3 Image bounding boxes](https://docs.bfl.ml/flux_3/flux3_image_bounding_boxes.md)
- [FLUX 3 Image API reference](https://docs.bfl.ml/api-reference/utility/generate-an-image-with-flux-3.md)
- [FLUX API pricing](https://bfl.ai/pricing)
- [Ideogram 4.5 product page and pricing](https://ideogram.ai/models/4.5/)
- [Ideogram 4.5 precise edit API](https://developer.ideogram.ai/api-reference/images/precise-edit/ideogram-4-5)
- [Riverflow 2.0](https://www.riverflow.ai/models/riverflow-2.0)
- [Riverflow 2.5](https://www.riverflow.ai/models/riverflow-2.5)
- [Riverflow Platform API](https://www.riverflow.ai/developers/api)
- [SAM 3 on fal](https://fal.ai/models/fal-ai/sam-3/image/llms.txt)
