# Selective Designer

Language for placing selected products and materials into an architect's image, rendering the edits on several image models, and choosing between the results.

## Language

### Designs and mood boards

**Design**:
One client image job: a base image with its mood board, drafts and render history.
_Avoid_: Project, workspace

**Archived design**:
A design hidden from the active list, with its images, items and history kept so it can be restored.

**Base image**:
The image the user uploads to start a design. It is kept unchanged as the root of the design's render tree.
_Avoid_: Original base image, architect render, original

**Mood board**:
A design's items, grouped by category.
_Avoid_: Reference group, library, board

**Item**:
A product, extract or swatch that can be placed on an image. It has a category, a name and an optional vendor and product link.
_Avoid_: Product reference, reference, asset

**Product**:
An item made from a product photo with its background removed. It must keep its silhouette, proportions, details and finish when rendered.

**Extract**:
An item cut out of a source photo.

**Swatch**:
An item representing a material, used to change a whole region.
_Avoid_: Texture

**Source photo**:
A room or product photo that extracts are cut from.

### Images and edits

**Render source**:
The image an edit set is applied to: the base image or a render result.
_Avoid_: Parent image

**Region**:
A selectable area of an image, made by the user or by a detection.
_Avoid_: Mask, selection, segment

**Detection**:
A region found automatically by segmentation.
_Avoid_: Auto-region

**Placement**:
One instance of an item positioned on an image, with its own position, scale and rotation.
_Avoid_: Layer

**Edit**:
One requested change to an image: a placement, a replacement, a removal or a material change.

**Edit set**:
The edits requested together in one render.

**Draft**:
The unfinished edits on a render source, saved as work progresses.

**Render recipe**:
The render source and edit set captured when a render is submitted. It never changes afterwards; revising it creates a new render.

### Rendering and review

**Render**:
One render recipe sent to every enabled model.
_Avoid_: Generation, run, job

**Batch**:
Several renders that differ only in which item fills one placement.

**Render result**:
The image one model returned for a render.
_Avoid_: Variant, fork, output

**Preferred result**:
The one render result per render that the user marks as best. The other results stay available for comparison and further editing.
_Avoid_: Best variant, favourite, pick

**Scheme**:
A render result the user has named so it can be found and compared later.

**Render tree**:
A base image and every render result descended from it.
_Avoid_: History graph

**Change warning**:
The checker's advisory that a render result differs from its render source outside the edit set.
_Avoid_: Drift alert

**Model scorecard**:
For each model, how often its render result was the preferred result.
_Avoid_: Rating, leaderboard
