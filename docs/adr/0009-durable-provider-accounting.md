# Capture provider accounting independently of output publication

Durably capture each performed provider request before publishing its usable output, then deliver the accounting to the cost log independently. Render and cutout checkpoints share a transaction with their receipts; automatic and interactive segmentation capture receipts before mask processing. A receipt still commits when its output loses the publication fence. Cost-log failure must not discard paid output or require another model call.

Receipts use provider, endpoint and native request identity when available, otherwise an invocation identity allocated before the provider call. Logical attempts and concepts are attribution, not deduplication identities. Success is immutable; accounting replay cannot replace a winning request's amount or regress its terminal status. Native request identity remains separate from provider polling URLs. Receipts retain original timestamps, unknown costs and attribution, have no cascading parent lifetime, and contain neither output URLs nor bytes. They do not protect storage objects from cleanup.

Delivery uses short transactions: lock a pending receipt, write the idempotent cost record, and acknowledge delivery together. Failure leaves it pending. Prompt bounded workflow retries are backed by a daily 07:00 UTC reconciliation workflow and an operator command. Snapshot pagination and isolated failures prevent a bad receipt from starving later requests. The cron endpoint requires its own secret; ordinary sessions do not authorize it.

The receipt is durable evidence, not exactly-once provider execution. A response lost before capture may still produce another charge, and a database outage can prevent capture and publication. Manual Retry intentionally starts a fresh potentially paid attempt. No historical accounting, output registration or terminal URL backfill is performed.

Recovery of a pre-receipt checkpoint retains its existing accounting key, avoiding a second historical cost row for the same returned work. This compatibility path does not backfill or repair historical records.
