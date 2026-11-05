# Isolate cutout attempts

A cutout attempt has its own stored identity and output key, separate from the item version a render recipe can pin. A workflow start can report an error after the queue accepted it, so a late worker could otherwise replace a newer result or overwrite a published image. The item version accepts a result only from its pending attempt.

Saving the attempt and starting the workflow remain separate operations. If the request process dies between them, a version remains pending until its owner can retry after expiry.

The owner can retry a failed attempt immediately or a pending attempt after 30 minutes. The new attempt starts a new window and takes over the right to publish. An earlier worker might still finish its provider call; its result cannot replace the new attempt. Older pending rows without a start time use the item version's creation time.

Keep a private provider-output checkpoint on the current attempt. Record performed provider work independently of publication. Once checkpointed, automatic retries reuse its URL or stored bytes and never invoke background removal again. Check the deterministic create-only destination before reading the URL, since a previous execution may have stored the output before publication failed. A late worker cannot replace a checkpoint or overwrite published bytes. Reference checks still span every item version before deleting an abandoned output, and uncertain checks retain it.

Manual Retry continues to claim a fresh attempt and clears its checkpoint; it can incur another provider charge. Provider work performed before a durable checkpoint is not guaranteed to execute exactly once. Byte-based responses are stored privately before their references are checkpointed, rather than putting images in database JSON or workflow payloads. There are no existing cutout jobs requiring compatibility with the previous workflow signatures.
