<p align="center">
  <img src="sherlock-transparent.png" alt="SherlockQA Logo" width="200">
</p>

<h1 align="center">SherlockQA</h1>

<p align="center">
  <em>Elementary, my dear developer. AI-powered code review and quality assurance.</em>
</p>

<p align="center">
  <a href="https://github.com/marketplace/actions/sherlockqa"><img src="https://img.shields.io/badge/Marketplace-SherlockQA-blue?logo=github" alt="GitHub Marketplace"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

SherlockQA is a GitHub Action that reviews your pull requests using AI, identifying bugs, security issues, and suggesting QA test scenarios.

## Features

- **AI Code Review** - Analyzes code for bugs, security vulnerabilities, and quality issues
- **Inline Comments** - Posts comments directly on problematic lines
- **QA Test Scenarios** - Suggests manual test cases based on code changes
- **Test Suggestions** - Recommends unit tests when new logic is added
- **Smart Verdicts** - Approves, requests changes, or flags PRs
- **Custom Prompts** - Add domain-specific context for better reviews
- **Multiple AI Providers** - Supports OpenAI, Azure OpenAI, and Azure Responses API

## Quick Start

Add to your workflow (`.github/workflows/sherlockqa.yml`):

```yaml
name: SherlockQA

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: mayurrawte/SherlockQA@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github-token` | GitHub token for API access | Yes | `${{ github.token }}` |
| `ai-provider` | AI provider (`openai`, `azure`, `azure-responses`) | No | `openai` |
| `openai-api-key` | OpenAI API key | Yes* | - |
| `azure-api-key` | Azure OpenAI API key | Yes* | - |
| `azure-endpoint` | Azure OpenAI endpoint URL | No | - |
| `azure-deployment` | Azure OpenAI deployment name | No | - |
| `azure-api-version` | Azure OpenAI API version | No | `2024-02-15-preview` |
| `model` | Model to use | No | `gpt-4` |
| `min-severity` | Minimum severity to report | No | `warning` |
| `ignore-patterns` | Files to ignore (comma-separated) | No | `*.md,*.txt,...` |
| `persona` | Custom persona/role instructions (e.g., "Act as a security engineer") | No | - |
| `domain-knowledge` | Domain-specific context for better reviews | No | - |
| `max-tokens` | Maximum tokens for AI response | No | `4096` |

*Either `openai-api-key` or `azure-api-key` is required based on provider.

## Outputs

| Output | Description |
|--------|-------------|
| `verdict` | Review verdict (`approved`, `needs_changes`, `do_not_merge`) |
| `summary` | Review summary |
| `issues-count` | Number of issues found |

## Usage Examples

### With OpenAI

```yaml
- uses: mayurrawte/SherlockQA@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    model: gpt-4
```

### With Azure OpenAI (Chat Completions API)

```yaml
- uses: mayurrawte/SherlockQA@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-provider: azure
    azure-api-key: ${{ secrets.AZURE_OPENAI_KEY }}
    azure-endpoint: https://your-resource.openai.azure.com
    azure-deployment: gpt-4
```

### With Azure Responses API

```yaml
- uses: mayurrawte/SherlockQA@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-provider: azure-responses
    azure-api-key: ${{ secrets.AZURE_API_KEY }}
    azure-endpoint: https://your-resource.cognitiveservices.azure.com
    azure-api-version: '2025-04-01-preview'
    model: gpt-5.1-codex-mini
```

### With Custom Domain Knowledge

```yaml
- uses: mayurrawte/SherlockQA@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    domain-knowledge: |
      Freight Forwarding SaaS Platform
      This is a logistics/freight forwarding platform. Think about:
      - Weight/Volume: Chargeable weight, unit conversions (kg/lb, cbm/cft)
      - Money: Currency conversions, rate calculations, rounding errors
      - Shipping: FCL/LCL, multi-leg shipments, container types
      - Documents: AWB, Bill of Lading, commercial invoices
      - Timezones: ETD/ETA dates across timezones
      - Edge cases: Zero weight, negative amounts, missing carrier data
```

### Full Configuration Example

```yaml
- uses: mayurrawte/SherlockQA@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-provider: azure-responses
    azure-api-key: ${{ secrets.AZURE_API_KEY }}
    azure-endpoint: https://your-resource.cognitiveservices.azure.com
    azure-api-version: '2025-04-01-preview'
    model: gpt-5.1-codex-mini
    min-severity: warning
    max-tokens: '16384'
    ignore-patterns: '*.md,*.txt,package-lock.json,yarn.lock,*.min.js'
    persona: Act as a senior security engineer with expertise in OWASP vulnerabilities
    domain-knowledge: |
      Your domain-specific context here...
```

## Example Review

When SherlockQA reviews your PR, you'll see:

```markdown
## 🔍 SherlockQA's Review

### 📝 Summary
This PR adds user authentication with JWT tokens.

### 🧪 Tests Required
⚠️ @author - Please add test cases for this change:
Add unit tests for token validation and expiration handling.

### 🎯 QA Test Scenarios
- [ ] Test login with invalid credentials
- [ ] Test token expiration after 24 hours
- [ ] Test concurrent sessions

### 🏁 Verdict
⚠️ Needs Changes
```

## Supported Languages

Works with all languages, with enhanced support for:
Python, JavaScript, TypeScript, Go, Java, C#, Ruby, PHP, Rust

## Privacy

- Only reads PR diffs, not your entire codebase
- Code is sent to your configured AI provider
- No code is stored or logged by SherlockQA

## License

MIT License - see [LICENSE](LICENSE) for details.

## Support

- [GitHub Issues](https://github.com/mayurrawte/SherlockQA/issues)
