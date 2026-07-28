# AWS Bedrock Provider Support

**Date:** 2026-07-28
**Status:** Implemented

## Goal

Add `bedrock` as an `ai-provider` option so teams running on AWS can use SherlockQA with models hosted on Amazon Bedrock, without adding any SDK dependency.

## Decisions

- **Auth: Bedrock API key (Bearer token).** AWS Bedrock API keys allow simple `Authorization: Bearer` auth over plain fetch, matching the repo's zero-SDK provider pattern. SigV4 / IAM-role / OIDC auth is explicitly out of scope (documented limitation; can be added later if requested).
- **API: Bedrock Converse API.** Model-agnostic — works with Claude, Llama, Mistral, Nova, etc. — with one uniform request/response shape and consistent token-usage fields. InvokeModel (Anthropic-native body format) is out of scope.
- **No streaming.** All existing providers are non-streaming; Bedrock follows suit.

## Inputs (action.yml)

| Input | Required | Default | Description |
|---|---|---|---|
| `bedrock-api-key` | when `ai-provider: bedrock` | — | AWS Bedrock API key (Bearer token) |
| `aws-region` | no | `us-east-1` | AWS region for the Bedrock runtime endpoint |

Update `ai-provider` description to include `bedrock`, and the action `description` to mention AWS Bedrock.

## Implementation

### `callBedrock(systemPrompt, userPrompt, model, maxTokens)`

```
POST https://bedrock-runtime.{region}.amazonaws.com/model/{encodeURIComponent(modelId)}/converse
Authorization: Bearer <bedrock-api-key>
Content-Type: application/json
```

Request body:

```json
{
  "system": [{ "text": "<systemPrompt>" }],
  "messages": [{ "role": "user", "content": [{ "text": "<userPrompt>" }] }],
  "inferenceConfig": { "maxTokens": <maxTokens> }
}
```

Response mapping (normalized to the shape the other `call*` functions return):

- text: all text blocks of `output.message.content` joined
- usage: `{ input: usage.inputTokens, output: usage.outputTokens }`
- response truncation: `stopReason === "max_tokens"`

Error handling mirrors `callAnthropic`: non-2xx → throw with status + response body excerpt.

### Wiring

- Add `'bedrock': (t) => callBedrock(systemPrompt, userPrompt, model, t)` to the provider dispatch map.
- `defaultModelFor('bedrock')` → `anthropic.claude-sonnet-5` (Bedrock model IDs carry the `anthropic.` provider prefix).

### Cost estimation

`estimateCost` currently prefix-matches against `claude-*` keys. Normalize the model ID before lookup: strip a leading `anthropic.`, `us.anthropic.`, or `eu.anthropic.` prefix so Bedrock Claude IDs reuse the existing pricing rows. Add pricing rows for `claude-sonnet-5` ($3/$15 per MTok) and `claude-opus-5` ($5/$25 per MTok). Non-Claude Bedrock models get no pricing match → cost stays `null` (existing behavior). Bedrock pricing is AWS-set and may differ from Anthropic list prices; the summary already labels cost as an estimate.

## Testing

Unit tests in `src/index.test.js`, mirroring existing provider tests with mocked `fetch`:

- request shape (URL includes region + encoded model ID, Bearer header, Converse body)
- response text + usage extraction
- `stopReason: "max_tokens"` → truncation flag
- non-2xx → thrown error
- `defaultModelFor('bedrock')`
- `estimateCost` with `anthropic.`-prefixed and `us.anthropic.`-prefixed IDs

## Docs

README: new Bedrock section — how to create a Bedrock API key, minimal workflow snippet, note that IAM-role/SigV4 auth is not supported, note that any Converse-compatible model ID works.

## Out of scope

SigV4 signing, AWS SDK, OIDC via `aws-actions/configure-aws-credentials`, InvokeModel, streaming, Bedrock guardrails.
