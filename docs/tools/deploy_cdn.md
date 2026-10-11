# deploy_cdn

Create CDN hosting and deploy a static asset directory to the OneBlink CDN via the oneblink CLI (the SDK has no CDN surface). Reach for it to publish a static site/assets to a OneBlink CDN scope; it optionally sets the CDN scope first and patches the .blinkmrc.json cdn config, then deploys the chosen folder. Production deploys (especially with --prune) fail closed unless confirmProduction is explicitly set.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectDir` | `string` | Required | Absolute path to the CDN project directory (contains .blinkmrc.json). |
| `deployDir` | `string` | Required | Folder whose contents map to CDN root, e.g. public or www. |
| `scope` | `string` | Optional | CDN scope/domain, e.g. customer-project.cdn.oneblink.io; when set, runs cdn scope first. |
| `env` | `enum: dev|test|prod` | Optional | Target environment; defaults to dev. |
| `prune` | `boolean` | Optional | Add --prune: remove CDN files no longer present locally (destructive); defaults to false. |
| `confirmProduction` | `boolean` | Optional | Required true to deploy when env=prod, else fails closed; defaults to false. |
| `cdnConfig` | `object` | Optional | Optional .blinkmrc.json cdn config to patch before deploy (scope, isSinglePageApplication, disableSecurityResponseHeaders, waf); omit to leave the file as-is. |
