# deploy_hosted_api

Create or update a OneBlink hosted API by deploying its project directory via the oneblink CLI (the SDK has no api-hosting surface). Reach for it to push a hosted-API codebase to an environment; it optionally sets the API scope first, then deploys. Deploying to prod requires confirmProduction (fails closed otherwise).

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectDir` | `string` | Required | Absolute path to the API codebase (contains .blinkmrc.json); used as the CLI cwd. |
| `scope` | `string` | Optional | API scope domain, e.g. customer-project.api.oneblink.io; when set, oneblink api scope <scope> runs before deploy. |
| `env` | `enum: dev|test|prod` | Optional | Target environment; defaults to dev. First deploy to a new env auto-provisions it. |
| `confirmProduction` | `boolean` | Optional | Required true to deploy to prod, else fails closed before any subprocess; defaults to false. |
