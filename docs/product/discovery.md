# Selective Designer discovery

Updated November 2, 2026. Planning is in progress. The [supplied PRD](source-prd-2026-11-02.md) is an unchanged source document, not an accepted specification. Recommendations and candidates below are not decisions.

## Confirmed direction

- Plan the product through an interview that challenges the PRD and explores alternatives.
- Minimize implementation by researching existing products and applicable libraries.
- Use research subagents for web searches.
- The first milestone should prove a real selection decision using the user's examples. Every render is user-initiated and applies all staged edits together; the milestone must not be limited to one change.
- Unintended changes produce advisory warnings for now. They do not automatically reject or block results.
- High product fidelity is required, superseding the PRD's style/material approximation. Product silhouette, proportions, distinctive details and finish must survive; perspective, lighting, shadows and reflections may adapt to the scene. A separate background-removal model is a candidate for preparing product references.
- The workspace combines an image canvas, a reference panel and a list of individually adjustable staged edits, with an explicit Render action.
- Save the editable recipe for every render. The user can reopen the same source image and edit set, change one element and regenerate the combination.
- The app saves multiple independent designs, each with one original base image and its own references, groups, edits and results. This replaces the PRD's many-images-per-project structure.
- Groups are arbitrary user-created collections for organizing product/material references, with no prescribed categories or taxonomy restrictions. Items from any group can be used together in one render; groups do not define render combinations.
- Implement both generation paths: apply an edit set to the original base image, or use an earlier render result as the render source. The user wants to compare these approaches.
- Product import automatically creates a background-removed preview. An erase/restore brush lets the user correct it, and the original product photo remains available.
- Initial editing tools cover placement/duplication, replacement/removal and regional material changes. Lighting requests use written instructions; dedicated light on/off controls are deferred.
- Continuing from a generated result starts a fresh draft containing only newly requested edits. Earlier changes stay in the image and its history rather than being reapplied automatically.
- Submitted recipes and outputs are preserved. Reopening and revising a recipe produces a new render record.
- Choosing the best result marks one preferred result within that render. All other outputs remain available for comparison and branching.
- Provide a results grid and synchronized side-by-side comparison of any two images, including the original and results from different branches. Show model and source labels.
- Autosave drafts, including edits, placements and mask corrections, and provide undo/redo while editing. Reopening a design restores unfinished work.
- First-release reference inputs are standalone product photos and material swatches. Extracting products from room photographs is deferred.
- A comparison from the original prepares a draft containing the combined intended changes from the branch and new edits. The user reviews and can adjust positions/masks before explicitly rendering.
- Automated variant batches are deferred. Recipe revision/duplication provides manual alternatives.
- Results appear individually as models finish. Work continues after leaving the page; reopening restores progress/results. A failed model can be retried without rerunning successful ones.
- Download the full returned image at native resolution, without app-added labels, watermarks or automatic upscaling. PDFs, public sharing and client feedback are deferred. Generation resolution is a separate pending model-setting decision.
- Version 1 serves one invited, signed-in user with private designs and assets. Reuse existing login infrastructure; no public signup, teams or billing.
- Each reference has an editable name defaulting from its filename. Vendor and product link are optional.
- Keep the checker very minimal and lightweight. The proposed implementation is a small client-side pixel-difference advisory outside requested edit regions, with no vision-model calls or automated product-fidelity scoring. This technical interpretation is explicit in the consolidated plan for final review.
- Log costs only. Cost estimates, spending caps/reservations, budget controls and a dedicated usage dashboard are outside the initial implementation.
- For a revised architect image, create a new design and support copying reference groups and placement data unchanged, with manual user adjustment. Do not perform automatic scene alignment or smart reprojection.
- Support archive/unarchive while retaining design assets/history; defer permanent deletion and apply no automatic expiry.
- Additional product photos are a future feature: keep stable product identities separate from image assets so the feature can be added later. Implement only one source product photo and its cutout now; no extra-photo UI or rendering support.
- Host on Vercel using Workflow SDK for durable work. Keep application records and provider adapters independent of the scheduler.
- The user supplies the base image as provided. No dedicated CAD-to-photoreal conversion or additional base-image preparation workflow is required.
- Render submits all staged edits to every configured model. The interface handles a variable number of results, and the user chooses the best one. The final model lineup is still undecided.
- Build the custom application. Existing editors are references for interaction design and capabilities; they are not a substitute for this implementation. An embedded editor library remains an implementation option.
- Interface planning and model investigation should proceed somewhat independently. A completed model evaluation and a validation budget are not prerequisites for planning the interface. The user will set the budget later.
- Remove the starter's book/catalog demonstration domain as part of the transition to this product. Application cleanup has not started.
- Record domain terminology when agreed and significant architectural trade-offs when decided. Agreed language is recorded in the [glossary](../../GLOSSARY.md); [ADR 0001](../adr/0001-build-custom-application.md) records the custom application, [ADR 0002](../adr/0002-support-original-and-result-render-sources.md) both generation paths, [ADR 0003](../adr/0003-preserve-submitted-render-recipes.md) immutable submitted recipes, and [ADR 0004](../adr/0004-vercel-workflow-hosting.md) hosting.

## Design tree

Questions 1–35 have been answered. The product-scope frontier is closed, with model integration and the numerical experiment budget explicitly deferred. The user has real examples; selecting representative images and timing the current workflow belong to later acceptance/model-fit work. The [consolidated implementation plan](implementation-plan.md) is ready for shared-understanding review before application changes.

1. **First useful result — accepted direction:** prove a real selection decision; the user has examples and a base image may need multiple edits. The concrete example has not been described or reviewed yet.
   - Initial edit types and acceptance criteria are settled. Select the concrete acceptance images and establish a time baseline during model-fit work; neither gates interface implementation.
2. **Preservation — decided:** warnings only for now; no automatic rejection or blocking on unintended changes.
   - Keep the checker minimal under question 30; the consolidated plan proposes a local visual-difference advisory. Product fidelity is reviewed manually against original references.
3. **Product fidelity — decided direction:** high fidelity is required; style/material approximation is insufficient. Background removal is a candidate source-preparation step, not proof of downstream fidelity.
   - Fidelity criteria and cutout correction are settled. Extra-angle photos are future-only under question 34; model-fit work must test viewpoint limitations of one source photo.
4. **Build boundary — decided:** proceed with the custom implementation and use existing editors as references.
   - The editor, saved-design boundaries, source/history rules, comparison, persistence, job recovery, downloads, invited access, revised-image transfer, archive behavior and hosting are settled.
5. **Validation investment — deferred by user:** budget later. Interface planning and model evaluation are somewhat orthogonal.
   - Continue interface/domain planning without picking winners or hard-coding a model lineup. Specific paid experiments need a concrete budget when the user sets it.
6. **Multiple edits — decided:** all staged changes are applied together in every user-initiated render.
   - Revisable recipes, fresh drafts on generated sources, undo/redo and editable reconstruction from the original are accepted. Automated batches are deferred.

7. **High fidelity — decided:** preserve silhouette, proportions, distinctive details and finish; allow perspective, lighting, shadows and reflections to adapt. Compare against the original product reference.
8. **Workspace — decided:** image canvas, reference panel, individually adjustable staged-change list and explicit Render action.
9. **Revising a combination — decided:** reopen a saved recipe, change selected edits and rerun from the same render source. Continuing from a generated result is also required, as confirmed in question 15.
10. **Organization — clarified:** one original base image per saved design, with arbitrary user-created groups. Questions 13 and 14 settle the saved-design boundaries and group purpose.
11. **Base-image handling — decided:** the user supplies the base image; no additional preparation/conversion flow.
12. **Model outputs — decided:** all staged edits go to every configured model; model count is not fixed in the UI, and the user chooses the best result.
13. **Saved designs — decided:** multiple independent saved designs, each with one original base image, its own groups, edits and results.
14. **Reference groups — decided:** arbitrary user-created collections with no prescribed categories or restrictions; references from different groups can be used together. Grouping is organizational, not a render-variant mechanism.
15. **Render sources — decided:** implement both original-image regeneration and rendering from a generated result, so the user can compare the outcomes.
16. **Product cutouts — decided:** automatic background-removal preview, manual erase/restore correction and retention of the original product photo.
17. **Initial tools — decided:** placement/duplication, replacement/removal, regional material edits and written lighting instructions. Dedicated light controls are deferred.
18. **Edits on a branch — decided:** a new draft on a generated source starts with only newly requested edits; inherited edits remain in the source and history.
19. **History — decided:** a revised recipe creates a new render; old submitted recipes and outputs remain unchanged.
20. **Choosing best — decided:** one preferred result per render; other outputs remain available for comparison or branching.
21. **Comparison — decided:** results grid plus synchronized side-by-side comparison of any two images, including original and different branches, with model and source labels.
22. **Draft persistence — decided:** autosave edits, placements and mask corrections; undo/redo while editing; restore unfinished work on reopen.
23. **Reference input scope — decided:** standalone product photos and material swatches initially; room-photo extraction deferred.
24. **Original-image comparison — decided:** reconstruct the branch's combined intended changes plus new edits into an original-source draft; allow user review and position/mask adjustments before rendering.
25. **Batch scope — decided:** automated batches deferred; manual alternatives use recipe revision/duplication.
26. **Job behavior — decided:** show outputs independently as ready, continue work after the page closes, restore progress/results on return and retry failed models independently of successful ones.
27. **Delivery — decided:** native full returned image download; no app-added labels, watermarks or automatic upscaling. PDF/public sharing/client feedback deferred; generation resolution remains a model-setting question.
28. **Access — decided:** one invited signed-in user, private designs/assets, existing login infrastructure; no public signup, teams or billing.
29. **Reference metadata — decided:** editable name with filename default; vendor and product link optional.
30. **Checker — decided direction:** very minimal and lightweight. Propose browser Canvas downsampled pixel-difference warnings only; no model calls, semantic inspection or product-identity scoring. Warnings stay advisory.
31. **Costs — decided:** log costs only. No estimates, spending caps/reservations or budget-control interface.
32. **Revised images — decided:** new design with optional reference-group copying and identical placement-data transfer, followed by manual adjustment. No smart alignment/reprojection.
33. **Retention — decided:** archive/unarchive with retained images/history; permanent deletion deferred; no automatic expiry.
34. **Additional photos — future-only:** architect for later support, but implement one primary product photo now. No additional-photo upload/gallery/provider behavior in this version.
35. **Hosting — decided:** Vercel with Workflow SDK.

### Shared-understanding review

No additional product-scope questions remain for the current plan. The explicit lightweight-checker implementation and exact placement-copy interpretation are included in the consolidated plan for review. The invoked grilling workflow requires confirmation of shared understanding before application implementation.

Generation resolution, enabled model lineup and provider-fit experiments remain model-integration decisions; the numerical experiment budget is deferred by the user. Interface implementation can proceed independently. No dedicated photoreal conversion, room-photo extraction, automated batches, extra-photo support, cost controls or extensive checker will be added under the agreed scope.

## Reference products and implementation alternatives

The custom application is now the chosen direction. Existing products below are interaction references and optional comparison baselines. They do not reopen the build decision. Model recipes and embedded editor libraries remain options within the custom implementation.

| Candidate | Potential work avoided | Evidence and remaining gap |
| --- | --- | --- |
| Existing Krea workflow | Custom model experiment UI, workflow chaining, some masking/compositing utilities; potentially a simple input/output app | [Nodes documentation](https://www.krea.ai/docs/user-guide/features/nodes) describes these capabilities. Current account entitlements and access to the exact requested models/settings remain unverified; its embedded model catalog is dated April 13, 2026. This is a pilot candidate, not proof that it meets the product requirements. |
| Existing editor plus small custom experiment/history tool | A complete placement and masking editor | [Photoshop reference placement/replacement](https://helpx.adobe.com/photoshop/desktop/create-open-import-images/create-images/use-reference-images-for-consistent-results.html) and [layer harmonization](https://helpx.adobe.com/uk/photoshop/desktop/repair-retouch/remove-objects-fill-space/blend-subjects-with-harmonize.html) overlap the proposed flow. Benchmark the real task before assuming history/export is sufficient. |
| Existing architectural rendering product | Domain-specific rendering UI | [Veras image controls](https://docs-chaos.atlassian.net/wiki/spaces/Veras/pages/1175388181/Image%2BTab) document uploaded images, references and selection tools, but also whole-image rerendering during masked edits for current engines. Specialization does not establish preservation. |
| Bounded edit/composite pipeline | Some drift checking and repeated manual review | [Adobe's composite API](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/object-composite/) distinguishes subject-preserving and adaptive placement. Adaptive placement has a background-preservation option. These are documented capabilities, not tested architectural-scene performance. |
| Limited custom app with one default model | Mandatory four-way rendering, comparison overload and several adapters at launch | Four models can be useful in evaluation without becoming compulsory on every user edit. Model count depends on measured quality and the user's preferences. |
| Full custom workbench | Closest to the supplied PRD | Highest implementation burden. Justified only if the smaller alternatives leave important needs unmet. |

## Existing code and demo removal

The workspace is a TanStack Start/React application with Query, Form, Drizzle/Postgres, provider-neutral auth ports, Better Auth, Better Upload with S3-compatible storage, UI primitives, telemetry and substantial verification infrastructure. Reuse is an option to assess, not a reason to retain irrelevant user-facing starter features. The current object-storage port supports upload handlers and deletion; persistent copying of model outputs still needs design.

The initial search found book/genre terms in 153 files across source, tests, scripts, documentation, migration metadata and configuration, excluding SQL files, snapshots and the generated route tree. This is a search inventory, not an estimate of implementation effort or a complete branding audit.

Cleanup must cover:

- Book and genre modules, route pages, route parameter helpers and composition factories.
- App/manager navigation, permissions, translation namespaces, fixtures and obsolete icons/assets where specific to the demo.
- Book-cover upload wiring while retaining reusable upload/storage infrastructure where useful.
- Seed data, current schema exports and relations, and any new generated migration required to remove demo tables. Existing migrations remain immutable under repository instructions.
- Book/genre-specific unit, browser, integration, E2E and visual coverage; replace relevant cross-cutting coverage instead of weakening it.
- Mutation-test commands, architecture policies, Semgrep exceptions, migration guards, CI references and the generated dependency graph.
- Starter branding and stale README/product metadata. Preserve required license attribution.

This directory currently has no Git repository metadata. Git-based changed-file tooling will need a usable checkout before its normal workflow can be relied on. No Git initialization or cleanup mutation was performed.

## Model research corrections

These findings come from official documentation, not paid generations. API account access, actual output quality, latency and billing have not been tested.

- **Krea 3:** regional editing, region boxes and up to eight input images are documented. A 2K output plus 2K scene and 1K reference is documented at $0.15 in fast mode or $0.17 with high thinking; the PRD's price needs its quality setting stated. Documentation also lists 4K, without guaranteeing exact arbitrary dimensions. [API overview](https://www.krea.ai/docs/developers/krea-3/overview).
- **FLUX 3 Image:** bounding boxes guide edits but do not clip them; preservation is described as usual rather than unconditional. Release notes confirm $0.100 for 2K. The documented version field currently exposes `latest`, so recording the request does not guarantee checkpoint reproducibility. [Box guidance](https://docs.bfl.ml/flux_3/flux3_image_bounding_boxes), [release notes](https://docs.bfl.ml/release-notes), [API reference](https://docs.bfl.ml/api-reference/utility/generate-an-image-with-flux-3).
- **Ideogram 4.5:** regional editing can retain a source up to 8192 × 8192 while limiting the working edit region to about 4 MP. Source resolution, edit resolution and export resolution therefore need separate decisions. Price depends on quality. [Precise Edit API](https://developer.ideogram.ai/api-reference/images/precise-edit/ideogram-4-5), [pricing](https://ideogram.ai/models/4.5/).
- **Riverflow 2.5:** uploaded-image editing with rectangular regions is documented. Reference support shown for parent-image edits does not prove the same input on the uploaded-image endpoint. A 30-credit example is not a universal cash price. [Platform API](https://www.riverflow.ai/app/platform-api/docs).
- **SAM 3:** fal marks its endpoint for commercial use at $0.005/request. The model uses Meta's custom SAM license. The documented endpoint is prompted segmentation; its default text prompt is "wheel", so an upload alone does not establish automatic whole-scene detection. CAD-render usefulness still requires testing. [fal endpoint](https://fal.ai/models/fal-ai/sam-3/image), [schema](https://fal.ai/models/fal-ai/sam-3/image/llms.txt), [license](https://github.com/facebookresearch/sam3/blob/main/LICENSE).

Any benchmark proposal must fit the still-undecided validation budget. Include a "none acceptable" outcome, manual quality review, actual review time, unwanted changes compared with both parent and original, and actual billed costs. A library or checker cannot establish these outcomes from documentation alone.

## High-fidelity reference preparation

The user's high-fidelity requirement changes the PRD's accuracy bar. Evaluate extraction fidelity and final rendered product fidelity separately; removing the background does not establish that a later generation preserves the product's shape or details.

- [BiRefNet v2](https://fal.ai/models/fal-ai/birefnet/v2/api) is a candidate for standalone product cutouts. Its API offers a Matting variant, mask output and foreground refinement. A source-preserving baseline can apply the generated mask to the original reference, while refined foreground output is evaluated separately.
- [SAM 3](https://fal.ai/models/fal-ai/sam-3/image/api) is a candidate for selecting target regions in scene images. Room-photo object extraction is deferred. Selection masks are not evidence of high-quality translucent-edge matting.
- [Adobe's composite API](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/object-composite/) explicitly distinguishes subject-preserving placement from adaptive regeneration. Its background-preservation parameter does not itself establish product fidelity. The examples show one object; simultaneous multi-product support must not be assumed.

Retention of the original product photo and a manual erase/restore correction UI are agreed. Keep original reference, mask and cutout as separately versioned assets so historical recipes retain their inputs. Archive retains assets with no automatic expiry; permanent deletion and extra product photos are deferred.

The fidelity acceptance examples should include thin stems/wires, translucent glass, identity-defining fixture details and final placement size. A different viewpoint can require inventing surfaces absent from the reference; perspective adaptation is allowed, while silhouette/proportions/details/finish must meet the agreed fidelity bar. Existing shadows, reflections and emitted light also need to be distinguished from the product's geometry and finish. [F, B, Alpha Matting](https://arxiv.org/abs/2003.07711) documents the distinction between opacity estimation and foreground-color recovery.

## Library shortlist

No packages have been installed or added. Vercel/Workflow is selected; react-konva/Konva is the proposed editor choice. Cutout, region and image-generation providers remain candidates for model-fit work. Earlier library alternatives are retained below as research evidence.

| Need | Candidate | Trade-off and evidence |
| --- | --- | --- |
| Focused custom image workspace | react-konva + Konva | React image primitives, transformations and free drawing; MIT. Controls, undo, keyboard behavior and application mask semantics remain custom. Keep the editor browser-side. [React integration](https://konvajs.org/docs/react/index.html), [transformer](https://konvajs.org/docs/react/Transformer.html), [brush](https://konvajs.org/docs/react/Free_Drawing.html), [SSR/version guidance](https://github.com/konvajs/react-konva/blob/master/README.md). |
| More conventional object editor | Fabric.js | Images, object controls, brushes and serialization; MIT. Its imperative object model needs deliberate synchronization with React/application state. [Core concepts](https://www.fabricjs.com/docs/core-concepts/), [repository/license](https://github.com/fabricjs/fabric.js). |
| Buy editor interactions | Pintura | Finished editor, image stickers, selections and retouch integration hooks. AI operations remain application-owned. The Developer plan was listed at €749/year/seat excluding VAT during research; verify the applicable tier before purchase. [React editor](https://pqina.nl/pintura/react-image-editor/), [stickers](https://pqina.nl/pintura/docs/v8/api/markup-editor/stickers/), [retouch hooks](https://pqina.nl/pintura/docs/v8/api/plugins/retouch/), [pricing](https://pqina.nl/pintura/pricing/). |
| Infinite canvas | tldraw | Broad editor surface, with commercial production license/key requirements. Consider only if an infinite canvas serves the chosen workflow. [License](https://tldraw.dev/community/license), [production keys](https://tldraw.dev/sdk-features/license-key). |
| Segmentation and cutouts | Hosted SAM 3 + BiRefNet v2 through fal | One SDK for both tasks; manual box/brush correction still needed. Hosted model pages mark commercial use. [SAM 3](https://fal.ai/models/fal-ai/sam-3/image), [BiRefNet](https://fal.ai/models/fal-ai/birefnet/v2), [client setup](https://fal.ai/docs/documentation/model-apis/inference/client-setup). |
| Durable work integrated with Vercel | Workflow SDK | Current official documentation explicitly supports TanStack Start/Nitro via the Vite plugin. On Vercel this can reduce the number of services; execution and billing still have platform limits. [TanStack integration](https://workflow-sdk.dev/docs/getting-started/tanstack-start), [Vercel workflows](https://vercel.com/docs/workflows), [current pricing/limits](https://vercel.com/docs/workflows/pricing). |
| Managed durable work | Trigger.dev | Retries, concurrency, task idempotency and realtime UI integration reduce worker plumbing; introduces a service dependency. [Tasks](https://trigger.dev/docs/tasks/overview), [realtime](https://trigger.dev/docs/realtime/overview). |
| Durable work on existing Postgres | pg-boss | Avoids a separate queue datastore; requires an always-running worker and application progress/operations design. [Introduction](https://pgboss.io/introduction). |
| Event/endpoint orchestration | Inngest | Independent child functions can isolate provider failures; parallel steps have different aggregate-failure semantics. [Fan-out guidance](https://www.inngest.com/docs/durable-execution/primitives/group-parallel). |

Side-by-side/grid comparison can begin with React/CSS. Add [React Compare Slider](https://github.com/nerdyman/react-compare-slider) only for a needed wipe interaction, or [React Flow](https://reactflow.dev/examples/layout/dagre) if a branching graph becomes more usable than thumbnail history.

Avoid introducing a generic image SDK solely to hide incompatible provider semantics. The [fal queue](https://fal.ai/docs/documentation/model-apis/inference/queue) helps with fal-hosted inference, but does not own application lineage, spending or storage. A durable task runner likewise does not make paid requests safe to resubmit after an ambiguous timeout: record provider request IDs, separate submission from polling/copying/checking, and plan spending reservations before fan-out.

Additional dependency caveats: [IMG.LY background removal](https://github.com/imgly/background-removal-js) uses AGPL with separate license options; [remove.bg's API documentation](https://www.remove.bg/api.doc) announces a December 1, 2026 transition to Leonardo.Ai. Neither is an automatic low-friction choice for this build.

The largest unresolved work is output quality and preservation, translating edit intent between models, usable review, durable provenance, private storage, and correct spending/recovery behavior. Library feature lists do not settle these requirements.

The final cost-logging-only scope excludes estimates and caps. Earlier research suggestions about cost reservations are not accepted implementation requirements. Request reconciliation is still required to avoid accidental duplicate generations during recovery.

## Hosting research update

The user selected Vercel with Workflow SDK. Its Vite integration explicitly supports this repo's TanStack Start/Nitro setup. Trigger.dev and pg-boss remain researched alternatives, not additional dependencies to introduce. [Workflow integration](https://workflow-sdk.dev/docs/getting-started/tanstack-start), [Trigger Node 24 support](https://trigger.dev/changelog/v4-5-7), [pg-boss](https://github.com/timgit/pg-boss), [Railway TanStack guide](https://railway.com/guides/tanstack-start).

Keep job execution separate from application records: immutable recipe and per-model attempt records live in Postgres; jobs carry identifiers, not image binaries; private object storage holds files. Separate external submission, polling, owned copying and checking. Scheduler idempotency does not guarantee a paid external call is purchased exactly once; provider request IDs and reconciliation remain adapter responsibilities. [Trigger idempotency semantics](https://trigger.dev/docs/idempotency).

## Minimal checker recommendation

Use browser Canvas already available beside the editor: draw the source/result at a small consistent size, read pixels outside requested edit regions and show an advisory visual-difference summary. Compute it when reviewing a result. Keep it out of the durable rendering path and make unavailable/error states harmless. No additional checker model, server-side image library, semantic segmentation or automated product-fidelity grade is planned.

Pixel comparison requires consistent coordinates and canvas-readable image access. Global lighting, compression or alignment changes may trigger warnings, and fine changes may be missed at small sizes. Present it as a visual-difference hint; high-fidelity product acceptance stays with the user. [Canvas drawing](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage), [pixel access](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/getImageData), [Konva image access guidance](https://konvajs.org/docs/posts/Tainted_Canvas.html).

Sharp is a documented fallback if server-side image processing later becomes necessary, not a current dependency. It supports resize/raw/composite operations but adds native packaging to verify on the actual deployment. [Sharp resize](https://sharp.pixelplumbing.com/api-resize/), [raw output](https://sharp.pixelplumbing.com/api-output/#raw), [installation](https://sharp.pixelplumbing.com/install/).

## Reconciliation (November 2, 2026)

A second planning interview ran at the same time as this one and reached some different decisions. The user resolved every conflict explicitly. Where they differ, the decisions below override the numbered design tree above, and [the implementation plan](implementation-plan.md) is the consolidated result.

| Topic | Earlier entry above | Final decision |
| --- | --- | --- |
| Organising items (14) | Arbitrary reference groups, no categories | Each item has a free-text **category**, with suggestions. A design's items form its **mood board**, grouped by category. Groups are dropped. |
| Segmentation | Prompted SAM 3 only; no automatic segmentation | **Eager** automatic detection with SAM 3 on every base image and every render result. It looks for a fixed architectural list plus the mood board's categories. Click, box, text, brush and lasso remain available. User-made regions carry over to continued results as editable suggestions. |
| Room-photo extraction (23) | Deferred | **In v1**: extracts are cut from source photos by click, box or description. |
| Batches (25) | Deferred | **In v1**: a batch is several renders that differ only in which item fills one placement. |
| Small-item warning | Not discussed | **In v1**: per-model size thresholds taken from vendor docs. |
| Whole-image prompts | Not in the initial tools | **Out of v1**, confirmed. |
| Checker (30) | Browser-side canvas difference | Confirmed. It is computed when a result is viewed and is unavailable when framing differs. |
| Download (27) | Native returned image | Confirmed. |
| Model lineup | Deferred | Krea 3, Ideogram 4.5 and GPT Image 2 through fal; FLUX 3 Image direct from Black Forest Labs. Riverflow is dropped: it has no mask or region input, and 2.6 replaced 2.5. Models live in a config registry. A model that can't take an edit set is skipped with a visible reason. |
| Placement input | Undecided | The item's cut-out goes in as a reference image, plus the target area (a box for Krea and FLUX, a mask for Ideogram and GPT Image 2). |
| Compositing | Not discussed | **Never**: render results stay raw ([ADR 0005](../adr/0005-raw-render-results-no-compositing.md)). The compare view adds swipe-to-reveal and onion skin. |
| Modules | `design` and `rendering` | Four: `design`, `moodboard`, `segmentation` and `rendering`. |
| Migrations | Never edit historical migrations | Demo migrations replaced by **one fresh baseline**. No deployed data existed. |
| Vocabulary | Original base image, product reference, reference group | Base image, item, mood board. Render source, render result, preferred result, draft and render recipe are kept. See [GLOSSARY.md](../../GLOSSARY.md). |
