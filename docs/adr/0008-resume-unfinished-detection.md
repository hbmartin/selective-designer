# Resume unfinished automatic detection

Persist the detection intent and image atomically. If intent persistence fails, retry the write before publishing the image. Dispatch happens after commit and the editor can recover it independently. An interrupted request can leave an intent that the image owner can recover in the editor. A confirmed failure before queue invocation is immediately retryable. Once the queue is invoked, a rejected response does not establish whether the worker was queued. When queue acceptance is uncertain, give the worker two minutes to claim the attempt. A claimed attempt has 30 minutes to finish. The owner can retry after failure or expiry, and a delayed worker cannot publish for the replacement attempt.

Record progress with the resulting regions so a retry runs only unfinished work. Restarting the whole detection would spend more provider calls and could replace regions already used in the editor. A replacement attempt owns future writes while completed regions and manual regions keep their identities.

For a revised design, attempt the mood board copy before dispatch. A reported copy failure also releases detection. The first worker snapshots the categories when it prepares the run, so edits saved between dispatch and preparation are included. If the copy never reports back, the owner can retry after two minutes and freeze the categories saved at that point. A late copy cannot change that run's snapshot.

A concept is complete when all returned masks are saved, including when the provider returns zero masks. A definitive prompt rejection or invalid mask leaves a visible omission. HTTP errors, unexpected content types, timeouts, and oversize declarations in headers remain retryable. A malformed or non-HTTPS source and a response body verified to exceed the mask limit are definitive rejections. Cleanup is limited to fresh uploads that definitively never published because a database error can arrive after commit.

Older runs have no checkpoints. Their automatic region labels are the available evidence of completion, so retry may repeat a concept that returned no masks or whose regions were renamed.

Apply the additive migration before deploying the new worker. On an existing deployment, verify that legacy workers without run ownership checks have drained before enabling the new reclaim behavior. Keep the previous workflow entry points available for replay. A historical image without a detection record may have completed successfully, so it is not automatically retried.
