# Host on Vercel with Workflow SDK

Use Vercel with Workflow SDK for durable rendering tasks; current official documentation supports the app's TanStack Start/Nitro setup. This reduces service and worker setup compared with a separate managed runner or an always-running queue worker, while accepting Vercel-specific deployment and execution constraints. Keep recipes, model attempts, costs and history in application-owned records, and isolate Workflow calls behind infrastructure/composition so the scheduler can be replaced.
