# Module Layer Dependencies

This diagram is generated from dependency-cruiser. Update it with `pnpm architecture:graph`; verify it with `pnpm architecture:graph:check`.

```mermaid
flowchart LR

subgraph module_account["account"]
  node_account_public["public"]
  node_account_application["application"]
  node_account_domain["domain"]
  node_account_presentation["presentation"]
  node_account_transport["transport"]
end

subgraph module_auth["auth"]
  node_auth_public["public"]
  node_auth_application["application"]
  node_auth_domain["domain"]
  node_auth_infrastructure["infrastructure"]
  node_auth_presentation["presentation"]
  node_auth_transport["transport"]
end

subgraph module_email["email"]
  node_email_public["public"]
  node_email_application["application"]
  node_email_domain["domain"]
  node_email_infrastructure["infrastructure"]
  node_email_presentation["presentation"]
  node_email_transport["transport"]
end

subgraph module_kernel["kernel"]
  node_kernel_public["public"]
  node_kernel_application["application"]
  node_kernel_domain["domain"]
  node_kernel_infrastructure["infrastructure"]
  node_kernel_transport["transport"]
end

subgraph module_user["user"]
  node_user_public["public"]
  node_user_application["application"]
  node_user_domain["domain"]
  node_user_presentation["presentation"]
  node_user_transport["transport"]
end

node_account_application --> node_account_domain
node_account_domain --> node_kernel_public
node_account_presentation --> node_account_domain
node_account_presentation --> node_account_public
node_account_presentation --> node_auth_public
node_account_public --> node_account_application
node_account_public --> node_account_domain
node_account_public --> node_account_presentation
node_account_public --> node_account_transport
node_account_transport --> node_account_domain
node_account_transport --> node_auth_public
node_account_transport --> node_kernel_transport
node_auth_domain --> node_kernel_domain
node_auth_infrastructure --> node_auth_domain
node_auth_infrastructure --> node_auth_public
node_auth_infrastructure --> node_kernel_domain
node_auth_infrastructure --> node_kernel_infrastructure
node_auth_infrastructure --> node_kernel_public
node_auth_infrastructure --> node_kernel_transport
node_auth_infrastructure --> node_user_public
node_auth_presentation --> node_account_public
node_auth_presentation --> node_auth_domain
node_auth_presentation --> node_auth_public
node_auth_presentation --> node_kernel_domain
node_auth_presentation --> node_kernel_public
node_auth_public --> node_auth_application
node_auth_public --> node_auth_domain
node_auth_public --> node_auth_infrastructure
node_auth_public --> node_auth_presentation
node_auth_public --> node_auth_transport
node_auth_transport --> node_auth_domain
node_auth_transport --> node_auth_public
node_auth_transport --> node_kernel_public
node_auth_transport --> node_kernel_transport
node_email_application --> node_email_domain
node_email_application --> node_kernel_domain
node_email_infrastructure --> node_email_public
node_email_infrastructure --> node_kernel_domain
node_email_infrastructure --> node_kernel_infrastructure
node_email_infrastructure --> node_kernel_public
node_email_presentation --> node_auth_public
node_email_public --> node_email_application
node_email_public --> node_email_domain
node_email_public --> node_email_infrastructure
node_email_public --> node_email_presentation
node_email_public --> node_email_transport
node_email_public --> node_kernel_public
node_email_transport --> node_email_public
node_email_transport --> node_kernel_domain
node_kernel_infrastructure --> node_auth_infrastructure
node_kernel_infrastructure --> node_email_infrastructure
node_kernel_infrastructure --> node_kernel_domain
node_kernel_infrastructure --> node_kernel_transport
node_kernel_public --> node_kernel_application
node_kernel_public --> node_kernel_domain
node_kernel_public --> node_kernel_infrastructure
node_kernel_public --> node_kernel_transport
node_kernel_transport --> node_kernel_domain
node_user_application --> node_user_domain
node_user_domain --> node_kernel_domain
node_user_presentation --> node_auth_public
node_user_presentation --> node_kernel_domain
node_user_presentation --> node_kernel_public
node_user_presentation --> node_user_domain
node_user_presentation --> node_user_public
node_user_public --> node_user_application
node_user_public --> node_user_domain
node_user_public --> node_user_presentation
node_user_public --> node_user_transport
node_user_transport --> node_auth_public
node_user_transport --> node_kernel_domain
node_user_transport --> node_kernel_transport
node_user_transport --> node_user_domain

linkStyle 6 stroke-dasharray: 1 4
linkStyle 7 stroke-dasharray: 1 4
linkStyle 8 stroke-dasharray: 1 4
linkStyle 10 stroke-dasharray: 6 4
linkStyle 26 stroke-dasharray: 1 4
linkStyle 42 stroke-dasharray: 1 4
linkStyle 44 stroke-dasharray: 1 4
linkStyle 50 stroke-dasharray: 1 4
linkStyle 53 stroke-dasharray: 1 4
linkStyle 54 stroke-dasharray: 1 4
linkStyle 56 stroke-dasharray: 6 4
linkStyle 66 stroke-dasharray: 1 4
linkStyle 67 stroke-dasharray: 1 4
linkStyle 68 stroke-dasharray: 1 4
linkStyle 69 stroke-dasharray: 6 4
```

## Edge Styles

- Solid edges are static runtime imports.
- Dashed edges are dynamic imports or type-only dependencies.
- Dotted edges are re-export-only dependencies.
