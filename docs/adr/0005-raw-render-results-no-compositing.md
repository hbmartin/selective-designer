# Keep render results raw; never composite them into the render source

Each render result is stored and shown exactly as the model returned it. We never paste generated pixels back into the render source inside a feathered mask, even though research recommended that technique ("paste-back" in Photoshop layers, InvokeAI and BrushNet) as the way to guarantee unchanged pixels outside an edit. The user chose raw results so every model's real behaviour stays visible and comparable, and to avoid compositing artefacts: seams, colour shifts at mask edges, and shadows or glow cut off at the mask boundary.

## Consequences

- The promise that "only what was asked changes" depends on the models. The browser-side checker shows a change warning, and the compare view (side-by-side, swipe and onion skin) lets the user inspect drift. Neither blocks, alters or reruns a result.
- Drift can build up over several rounds of continuing from render results. Rendering from the base image (ADR 0002) is the escape hatch.
- If the first user rejects the results because of drift, revisit this decision. Paste-back could be added as an optional view of a result without changing the stored raw result.
