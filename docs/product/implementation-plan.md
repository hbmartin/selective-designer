# Selective Designer implementation plan

Approved November 2, 2026. This plan replaces the earlier draft. It merges [discovery](discovery.md) and a parallel grilling interview; the [Reconciliation](discovery.md#reconciliation-november-2-2026) section records which decisions changed. The [source PRD](source-prd-2026-11-02.md) is kept unchanged as the original proposal.

## Context
This repo is the `start-ui-web` TanStack Start starter: a modular monolith with hexagonal modules, Drizzle/Postgres, Better Auth and Better Upload. Its book/genre demo is being replaced by **Selective Designer**. A selections coordinator uploads an architect's image, places mood-board items into it, sends the edits to four image models, and compares and continues from the results. All of v1 is built in one go; there is no separate evaluation-only phase.

Decisions come from two planning interviews held on the same day. Conflicts between them were resolved explicitly; see the Reconciliation section of the discovery doc.

## Merged decisions
**Product**
- **Design.** A design has exactly one **base image**. A revised architect image becomes a new design, with items and placement data copied unchanged and then adjusted by hand. Designs can be archived and unarchived. There is no permanent deletion in v1.
- **Mood board.** Each design has its own mood board of **items**. An item is a **product** (background removed with BiRefNet, original photo kept, cut-out corrected with an erase/restore brush), an **extract** (cut from a **source photo** by click, box or description), or a **swatch**. Items carry a free-text category with suggestions and a name defaulting to the filename. Vendor and product link are optional. Product fidelity must be high: silhouette, proportions, details and finish.
- **Edit tools.** Placement (move, resize, rotate, duplicate), replacement (an item assigned to a region), removal, and region material change (from a swatch or written text). Lighting is written prompt text only; there is no light switch and no special glow handling. Whole-image prompts are **out of v1**, and so is CAD-to-photoreal conversion.
- **Drafts and recipes.** Drafts autosave and support undo/redo. A submitted **render recipe** is immutable and snapshots the versions of cut-outs and masks it used (ADR 0003). Revising a recipe creates a new render.
- **Render sources.** A render can start from the base image or from any render result (ADR 0002). A new draft on a result starts with only the new edits. "Compare from original" rebuilds the combined intended edits into an editable draft on the base image.
- **Rendering.**
  - Every render goes to every enabled model, with one **render result** per model.
  - **Batch**: several renders that differ only in which item fills one placement.
  - If a model can't accept the edit set (for example, too many reference images), the pre-render check warns and that model is **skipped** with a visible reason. Edits are never silently dropped.
  - A small-item warning uses per-model thresholds from vendor docs (FLUX ≈ 40×25 px).
  - Each model fails and retries on its own. Work continues after the page is closed.
- **Review.**
  - At most one **preferred result** per render; the others are kept for comparison and branching.
  - A result can be named as a **scheme**.
  - Views: a results grid, side-by-side comparison with synchronised pan and zoom, **swipe-to-reveal**, and **onion skin**.
  - The **model scorecard** shows how often each model's result was preferred.
  - Download returns the **native returned image** with no label, watermark or upscaling.
- **Outputs are raw.** Results are never composited back into the source; this becomes new ADR 0005. The **checker runs in the browser** when a result is viewed. It downsamples and blurs both images, compares them outside a widened edit mask, and shows a heatmap and the percentage changed. It is advisory only, and shows "unavailable" when the framing differs or the edit mask can't be computed.
- **Segmentation is eager.** SAM 3 auto-detection runs on every base image and every render result. It looks for a fixed architectural list (config) plus the categories on the design's mood board. The user can also click, draw a box, type a description, brush or lasso. Regions the user made on a render source are copied onto results continued from it, as editable suggestions.
- **Access and cost.** One invited user; public sign-up is off; English only. Every provider call's cost is logged in the database, with no UI and no cap. Costs record their source: reported by the provider, from a price table, or unavailable.

**Stack and integration**
- **Hosting:** Vercel, with the Workflow SDK running renders (ADR 0004), Neon via the Vercel Marketplace, and a **private Cloudflare R2** bucket with short-lived signed GET URLs. MinIO is used locally. R2 and MinIO need CORS configured so Konva canvases aren't tainted.
- **Models:** a config registry with one adapter each.

  | Model | Route | Targeting |
  |---|---|---|
  | Krea 3 | fal `krea/v3/edit` | `regions` boxes + `regional_edit`; reasoning `high`/`ultra` |
  | Ideogram 4.5 | fal `ideogram/v4.5/edit` | `mask_url`, black = edit; max 3 references with a mask |
  | GPT Image 2 | fal `openai/gpt-image-2/edit` | `mask_url`, white = edit |
  | FLUX 3 Image | BFL direct `/v1/flux-3-image` | `match_input`; boxes on a 0–1000 grid in the prompt |

  - FLUX 3 is polled, and its result must be copied within 10 minutes.
  - SAM 3 (`fal-ai/sam-3/image`) and BiRefNet (`fal-ai/birefnet/v2`) also run through fal.
  - **Placement input:** the item's cut-out goes in as a reference image, plus the target area (a box for Krea and FLUX, a mask for Ideogram and GPT Image 2). Rotation is described in the prompt.
- **No server image library.**
  - The browser makes a working copy of the base image (2048 px long edge) at upload and exports masks at native size.
  - The browser also does the checker, the resampling for comparisons, and cutting extracts.
  - The server only combines masks and flips mask colours, using a pure-JS PNG codec (`fast-png` or `pngjs`).
- **Libraries:** react-konva + konva, `@fal-ai/client`, `workflow`, pixelmatch (in the browser), react-compare-slider + react-zoom-pan-pinch, `@atlaskit/pragmatic-drag-and-drop`, Better Upload dropzone + `onPaste`, and zustand (already in the repo). The **render tree** starts as a source-linked thumbnail history, with no graph library.
- **Modules:** four.
  - `design`: designs, base image, uploads, archive, revised-image copy.
  - `moodboard`: items, versions, source photos, extraction, background removal, cut-out correction.
  - `segmentation`: regions, SAM runs, auto-detection, carry-over.
  - `rendering`: drafts, edit sets, recipes, renders, batches, results, preferred result, schemes, model registry and adapters, workflows, cost log.
  - `kernel`, `auth`, `user`, `account` and `email` stay.
- **Migrations:** start from a **fresh baseline**. Quality gates stay standard: `pnpm check`, unit, integration and e2e tests, and visual snapshots. There are no mutation-test configs for the new modules yet.

## Glossary (rewrite `GLOSSARY.md` in P0)
- **Design**: one client image job, holding a base image, a mood board, drafts and render history. **Archived design**: one hidden from the active list, with everything kept.
- **Base image**: the design's uploaded image, kept unchanged. _Avoid_: original base image, architect render.
- **Render source**: the image an edit set is applied to, either the base image or a render result.
- **Mood board**: a design's items, grouped by category. _Avoid_: reference group, library.
- **Item**: a product, extract or swatch that can be placed, with a category, name and optional vendor/link. **Product**: from a product photo, background removed. **Extract**: cut from a source photo. **Swatch**: a material for region-wide changes. **Source photo**: a room or product photo that extracts come from. _Avoid_: product reference, asset.
- **Region**: a selectable area of an image. **Detection**: a region found automatically. _Avoid_: mask, segment.
- **Placement**: an item positioned on an image, with position, scale and rotation.
- **Edit**: one requested change. **Edit set**: the edits requested together in one render. **Draft**: unfinished edits on a render source, autosaved. **Render recipe**: the immutable render source plus the edit set captured at submit.
- **Render**: one recipe sent to every enabled model. **Batch**: renders that differ only in which item fills one placement.
- **Render result**: one model's output from a render. _Avoid_: variant, fork, output. **Preferred result**: the one result per render the user marks. _Avoid_: best, favourite, pick. **Scheme**: a named render result.
- **Render tree**: a base image and every render result descended from it.
- **Change warning**: the checker's advisory about changes outside the edit set.
- **Model scorecard**: for each model, how often its result was preferred.

## Phases (each ends with `pnpm format:changed && pnpm check && pnpm test` passing)
**P0: Demo removal, baseline reset, docs**
- **Setup.** Run `pnpm install`. Do the reset first, then `git init` and the first commit, so `check:migrations` passes with no allowlist.
- **Delete** `src/modules/{book,genre}` and `src/composition/{book,book-upload,genre}.ts`, and remove their wiring from `src/composition/index.ts`.
- **Delete the demo routes:** `src/routes/{app,manager}/books/*`, `parseRouteBookId` in `-route-params.ts`, and `src/routes/api/upload.ts` (it comes back in P2).
- **Clean up references in other modules:**
  - kernel: `domain/ids.ts`, `backend.ts`, `infrastructure/db/schema/{index,relations}.ts`.
  - `auth/domain/permissions.ts`: drop book/genre and add `design`.
  - Nav: `main-nav-config.ts`, `nav-sidebar.tsx`.
  - Styles: the `app.css` book-cover tokens.
- **Content and config cleanup:**
  - i18n: delete the `fr`, `ar` and `sw` locales, set `AVAILABLE_LANGUAGES = ['en']`, and remove `book.json` and `genre.json`.
  - Seed: remove `drizzle/seed/book*`.
  - Config: the Stryker configs, the `test:mutation*` scripts, the mutation workflow matrix, `.dependency-cruiser.cjs` (change hard-coded module lists to `[^/]+`), `sheriff.config.ts` and `.semgrep.yml`.
  - Tests: about 40 shared tests and fixtures.
  - Env: `.env.example` gets `VITE_AUTH_SIGNUP_ENABLED=false`.
- **Migration reset:** remove the schemas, delete `drizzle/migrations/*` and `meta/`, run `pnpm db:generate --name baseline` (auth and email tables only), change `scripts/check-migration-edits.mjs` `SCHEMA_PATHS` to a glob, then recreate local databases with `pnpm dk:clear && pnpm dk:init && pnpm db:migrate`.
- **Docs:**
  - Rewrite `GLOSSARY.md`.
  - Add `docs/adr/0005-raw-render-results-no-compositing.md`.
  - Add a "Reconciliation" section to `docs/product/discovery.md` listing the overrides (C1–C8, T1–T3, model lineup, eager segmentation).
  - Replace `docs/product/implementation-plan.md` with this plan.
  - Rewrite `docs/security-upload.md` for private assets.
  - Run `pnpm architecture:graph`.

**P1: Infrastructure**
- **Vite:** add `workflow()` from `workflow/vite` as the **first** plugin in `vite.config.ts`, and the workflow tsconfig plugin.
- **Provider config:** add `kernel/infrastructure/config/ai-providers.ts` (`FAL_KEY`, `BFL_API_KEY`, `PROVIDER_MODE=live|fake`, `PROVIDER_CALLBACK_MODE=webhook|poll`, `VERCEL_AUTOMATION_BYPASS_SECRET`, `RENDER_ENABLED_MODELS`) and register it in `config/server.ts`.
- **Storage:** extend `kernel/application/ports/object-storage.ts` with `putObject`, `getObjectBytes`, `createSignedReadUrl` and `copyFromUrl`, implemented in `kernel/infrastructure/storage/better-upload.ts` with aws4fetch signing. Remove `VITE_S3_BUCKET_PUBLIC_URL` and fix CSP `img-src`.
- **Uploads:** add a DB-backed `upload_intent` table to replace the in-memory `SecondaryStore` binding, which breaks across Vercel instances. Generalise `book-policy.ts` into a kernel `upload-policy.ts`.
- **Cost log:** a `provider_call` table.
- **fal:** a shared client and an ED25519 webhook verifier, plus `kernel/transport/workflow/step-result-mapper.ts` (`Ok` → value; `AppError` → `RetryableError` or `FatalError`).
- **Spike:** a throwaway workflow plus a fal call on a Vercel preview, to check the Workflow SDK against the pinned TanStack Start 1.168, `nitro-nightly`, Vite 8, `src/start.ts` middleware and deployment protection.

**P2: `design`**
- **Tables:** `design(id, ownerId, name, archivedAt, copiedFromDesignId?)` and `image` (kind `base|result|source_photo`, `originalKey`, `workingKey`, dimensions, `ingestStatus`).
- **Use cases:** list, create, rename, archive and unarchive; upload the base image (the browser uploads the original plus a 2048 px working copy); create a revised-image design with item and placement copy; signed download.
- **Routes:** `/app/designs` (`validateSearch {q, archived}` + `loaderDeps`), `/api/upload`, `/api/images/$imageId/download`.

**P3: `moodboard`**
- **Tables:** `item(kind product|extract|swatch, category, name, vendor?, url?, currentVersionId)`, `item_version(photoKey, cutoutKey, maskKey, status)` and `source_photo`.
- **Use cases:** background removal through a workflow; cut-out erase/restore saved as a new version; extraction from a source photo (SAM prompt, then the browser crops with the mask and uploads); category suggestions.
- **UI:** a mood-board panel with categories, a dropzone and paste support.

**P4: `segmentation`**
- **Tables:** `segmentation_run` and `region(source detection|click|box|text|brush|lasso, maskKey, bbox, concept, isSuggestion, carriedFromRegionId?)`.
- **Use cases:** interactive `segmentByPrompt`; manual regions saved through a presigned mask upload, because server-function bodies are capped at 1 MiB; `carryOverRegions`.
- **`autoDetectWorkflow`:** loads the concepts (the fixed list plus the design's categories), then runs one step per concept with `Promise.allSettled`. It is triggered when an image arrives, for both base images and results.

**P5: `rendering` pipeline**
- **Domain:** `model-catalog.ts` (targeting, mask polarity, reference limits, minimum target size), `edit-set.ts` (a zod union), `render-plan.ts` (include or skip each model, plus small-item warnings) and `prompt-builder.ts`.
- **Tables:** `draft(renderSourceImageId, revision)`, `edit`, `render(recipe jsonb snapshot, batchId?, preferredResultId?)`, `batch`, `render_result(status pending|running|succeeded|failed|skipped, skipReason, attempt, providerRequestId, model, version, settings, prompt, outputImageId, framingChanged, error)` and `scheme`.
- **Adapters:** `providers/fal/{krea-v3,ideogram-v4-5,gpt-image-2}.ts`, `providers/bfl/flux-3-image.ts` and `providers/fake/*`.
- **Workflow:** `transport/workflows/render-workflow.ts` runs `Promise.allSettled(runResult)`. Each result is submitted idempotently, then waits on a hook resumed by the verified `/api/webhooks/fal` route (raced against `sleep` as a fallback), or is polled locally or for BFL. The output is copied straight to `results/{id}/{attempt}/raw.*`, the image-arrived listener fires (carry-over plus auto-detection), and the cost is logged.
- **Retry:** `retryResult` starts a single-result workflow.
- **Permissions:** steps call pipeline use cases exported through `backend.ts`, because a step has no request headers for permission checks.

**P6: Editor UI**
- **Canvas:** `src/platform/components/canvas/*` provides the Konva stage, Transformer, brush and lasso, mask overlay with `drawHitFromCache`, and native-size export. It is loaded client-only.
- **Editor:** `rendering/presentation/editor/*` holds the zustand draft with undo, autosave against the draft revision, the pre-render dialog (skips and small-item warnings) and batch setup.
- **Screen:** composed in `src/app/workspace/presentation/design-editor.tsx`.
- **Route:** `/app/designs/$designId/edit`, with `validateSearch {sourceImageId?}` and a 1.5 s `refetchInterval` while anything is pending.

**P7: Review**
- **Use cases:** `markPreferredResult`, schemes, "compare from original" draft reconstruction, and the scorecard.
- **Routes:**
  - the thumbnail render tree;
  - `/renders/$renderId` (grid);
  - `/compare` with `validateSearch {a, b, mode: side|swipe|onion, opacity}`;
  - `/app/scorecard`.
- **Checker:** a browser-side hook using canvas and pixelmatch.

**P8: Hardening and deploy**
- **E2E tests** (designs, editor render, compare, retry) with `PROVIDER_MODE=fake`, poll mode and the local workflow world.
- **Visual baselines** for the designs list, editor and compare screens.
- **Vercel setup:** Neon pooled URL, private R2 with CORS, protection-bypass secret, and the seeded invited user.
- **Docs:** update `README.md` and `AGENTS.md`.
- **Smoke test:** a manual `scripts/smoke-model.ts`, kept out of CI, to check fal mask polarity and the FLUX grid syntax against the real models.

## Verification
- **Per phase:** run `pnpm format:changed && pnpm check && pnpm test:affected`. Run `pnpm check:migrations` whenever schema files change.
- **Unit tests:** render-plan skip matrix, FLUX prompt-grid golden strings, mask polarity, step-result mapper, webhook verifier, recipe immutability.
- **Integration tests (PGlite):** repositories and the upload intent.
- **Workflow tests:** orchestration tested with `vi.mock('workflow')`.
- **UI:** `pnpm dev` with MinIO and `PROVIDER_MODE=fake`, then walk through: create a design → upload → mood board → place → render → retry a failed model → prefer a result → compare (side, swipe, onion) → download. Check console errors and layout at desktop and mobile sizes, then run `pnpm test:e2e --project=chromium` and `pnpm test:e2e:visual`.
- **Deploy:** Vercel preview with real keys, using one real render per model.
- **Before merge:** `pnpm verify`.
