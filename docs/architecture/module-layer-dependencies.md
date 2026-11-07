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

subgraph module_design["design"]
  node_design_public["public"]
  node_design_application["application"]
  node_design_domain["domain"]
  node_design_infrastructure["infrastructure"]
  node_design_presentation["presentation"]
  node_design_transport["transport"]
end

subgraph module_email["email"]
  node_email_public["public"]
  node_email_application["application"]
  node_email_domain["domain"]
  node_email_infrastructure["infrastructure"]
  node_email_transport["transport"]
end

subgraph module_kernel["kernel"]
  node_kernel_public["public"]
  node_kernel_application["application"]
  node_kernel_domain["domain"]
  node_kernel_infrastructure["infrastructure"]
  node_kernel_transport["transport"]
end

subgraph module_moodboard["moodboard"]
  node_moodboard_public["public"]
  node_moodboard_application["application"]
  node_moodboard_domain["domain"]
  node_moodboard_infrastructure["infrastructure"]
  node_moodboard_presentation["presentation"]
  node_moodboard_transport["transport"]
end

subgraph module_rendering["rendering"]
  node_rendering_public["public"]
  node_rendering_application["application"]
  node_rendering_domain["domain"]
  node_rendering_infrastructure["infrastructure"]
  node_rendering_presentation["presentation"]
  node_rendering_transport["transport"]
end

subgraph module_segmentation["segmentation"]
  node_segmentation_public["public"]
  node_segmentation_application["application"]
  node_segmentation_domain["domain"]
  node_segmentation_infrastructure["infrastructure"]
  node_segmentation_presentation["presentation"]
  node_segmentation_transport["transport"]
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
node_auth_infrastructure --> node_kernel_domain
node_auth_infrastructure --> node_kernel_infrastructure
node_auth_infrastructure --> node_kernel_public
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
node_design_application --> node_design_domain
node_design_application --> node_kernel_domain
node_design_infrastructure --> node_auth_infrastructure
node_design_infrastructure --> node_design_domain
node_design_infrastructure --> node_kernel_domain
node_design_infrastructure --> node_kernel_infrastructure
node_design_presentation --> node_auth_public
node_design_presentation --> node_design_domain
node_design_presentation --> node_design_public
node_design_presentation --> node_kernel_domain
node_design_public --> node_design_application
node_design_public --> node_design_domain
node_design_public --> node_design_infrastructure
node_design_public --> node_design_presentation
node_design_public --> node_design_transport
node_design_transport --> node_auth_public
node_design_transport --> node_design_domain
node_design_transport --> node_kernel_domain
node_design_transport --> node_kernel_public
node_design_transport --> node_kernel_transport
node_email_application --> node_email_domain
node_email_application --> node_kernel_domain
node_email_infrastructure --> node_email_public
node_email_infrastructure --> node_kernel_domain
node_email_infrastructure --> node_kernel_infrastructure
node_email_infrastructure --> node_kernel_public
node_email_public --> node_email_application
node_email_public --> node_email_domain
node_email_public --> node_email_infrastructure
node_email_public --> node_email_transport
node_email_public --> node_kernel_public
node_email_transport --> node_email_public
node_email_transport --> node_kernel_domain
node_kernel_application --> node_kernel_domain
node_kernel_infrastructure --> node_auth_infrastructure
node_kernel_infrastructure --> node_design_infrastructure
node_kernel_infrastructure --> node_email_infrastructure
node_kernel_infrastructure --> node_kernel_domain
node_kernel_infrastructure --> node_kernel_transport
node_kernel_infrastructure --> node_moodboard_infrastructure
node_kernel_infrastructure --> node_rendering_infrastructure
node_kernel_infrastructure --> node_segmentation_infrastructure
node_kernel_public --> node_kernel_application
node_kernel_public --> node_kernel_domain
node_kernel_public --> node_kernel_infrastructure
node_kernel_public --> node_kernel_transport
node_kernel_transport --> node_kernel_domain
node_moodboard_application --> node_kernel_domain
node_moodboard_application --> node_moodboard_domain
node_moodboard_infrastructure --> node_design_infrastructure
node_moodboard_infrastructure --> node_kernel_domain
node_moodboard_infrastructure --> node_kernel_infrastructure
node_moodboard_infrastructure --> node_moodboard_domain
node_moodboard_presentation --> node_auth_public
node_moodboard_presentation --> node_design_public
node_moodboard_presentation --> node_kernel_domain
node_moodboard_presentation --> node_moodboard_domain
node_moodboard_presentation --> node_moodboard_public
node_moodboard_public --> node_kernel_application
node_moodboard_public --> node_moodboard_application
node_moodboard_public --> node_moodboard_domain
node_moodboard_public --> node_moodboard_infrastructure
node_moodboard_public --> node_moodboard_presentation
node_moodboard_public --> node_moodboard_transport
node_moodboard_transport --> node_auth_public
node_moodboard_transport --> node_kernel_domain
node_moodboard_transport --> node_kernel_transport
node_moodboard_transport --> node_moodboard_domain
node_rendering_application --> node_kernel_domain
node_rendering_application --> node_rendering_domain
node_rendering_domain --> node_kernel_domain
node_rendering_infrastructure --> node_design_infrastructure
node_rendering_infrastructure --> node_kernel_domain
node_rendering_infrastructure --> node_kernel_infrastructure
node_rendering_infrastructure --> node_rendering_application
node_rendering_infrastructure --> node_rendering_domain
node_rendering_presentation --> node_auth_public
node_rendering_presentation --> node_rendering_domain
node_rendering_presentation --> node_rendering_public
node_rendering_public --> node_rendering_application
node_rendering_public --> node_rendering_domain
node_rendering_public --> node_rendering_infrastructure
node_rendering_public --> node_rendering_presentation
node_rendering_public --> node_rendering_transport
node_rendering_transport --> node_auth_public
node_rendering_transport --> node_kernel_domain
node_rendering_transport --> node_kernel_transport
node_rendering_transport --> node_rendering_application
node_rendering_transport --> node_rendering_domain
node_segmentation_application --> node_kernel_application
node_segmentation_application --> node_kernel_domain
node_segmentation_application --> node_segmentation_domain
node_segmentation_domain --> node_kernel_domain
node_segmentation_infrastructure --> node_design_infrastructure
node_segmentation_infrastructure --> node_kernel_domain
node_segmentation_infrastructure --> node_kernel_infrastructure
node_segmentation_infrastructure --> node_segmentation_domain
node_segmentation_presentation --> node_auth_public
node_segmentation_presentation --> node_segmentation_application
node_segmentation_presentation --> node_segmentation_public
node_segmentation_public --> node_kernel_application
node_segmentation_public --> node_segmentation_application
node_segmentation_public --> node_segmentation_domain
node_segmentation_public --> node_segmentation_infrastructure
node_segmentation_public --> node_segmentation_presentation
node_segmentation_public --> node_segmentation_transport
node_segmentation_transport --> node_auth_public
node_segmentation_transport --> node_kernel_domain
node_segmentation_transport --> node_kernel_transport
node_segmentation_transport --> node_segmentation_domain
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
linkStyle 24 stroke-dasharray: 1 4
linkStyle 43 stroke-dasharray: 1 4
linkStyle 45 stroke-dasharray: 1 4
linkStyle 46 stroke-dasharray: 1 4
linkStyle 47 stroke-dasharray: 6 4
linkStyle 59 stroke-dasharray: 1 4
linkStyle 65 stroke-dasharray: 1 4
linkStyle 67 stroke-dasharray: 1 4
linkStyle 68 stroke-dasharray: 1 4
linkStyle 71 stroke-dasharray: 1 4
linkStyle 72 stroke-dasharray: 1 4
linkStyle 73 stroke-dasharray: 1 4
linkStyle 74 stroke-dasharray: 1 4
linkStyle 75 stroke-dasharray: 1 4
linkStyle 77 stroke-dasharray: 6 4
linkStyle 92 stroke-dasharray: 1 4
linkStyle 94 stroke-dasharray: 1 4
linkStyle 95 stroke-dasharray: 1 4
linkStyle 96 stroke-dasharray: 6 4
linkStyle 112 stroke-dasharray: 1 4
linkStyle 114 stroke-dasharray: 1 4
linkStyle 115 stroke-dasharray: 1 4
linkStyle 116 stroke-dasharray: 6 4
linkStyle 136 stroke-dasharray: 1 4
linkStyle 137 stroke-dasharray: 1 4
linkStyle 138 stroke-dasharray: 6 4
linkStyle 150 stroke-dasharray: 1 4
linkStyle 151 stroke-dasharray: 1 4
linkStyle 152 stroke-dasharray: 1 4
linkStyle 153 stroke-dasharray: 6 4
```

## Edge Styles

- Solid edges are static runtime imports.
- Dashed edges are dynamic imports or type-only dependencies.
- Dotted edges are re-export-only dependencies.
