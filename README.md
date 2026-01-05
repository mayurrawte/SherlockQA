# SherlockQA

> Elementary, my dear developer. AI-powered code review and quality assurance.

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-SherlockQA-blue?logo=github)](https://github.com/marketplace/actions/sherlockqa)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

SherlockQA is a GitHub Action that reviews your pull requests using AI, identifying bugs, security issues, and suggesting QA test scenarios.

## Features

- **AI Code Review** - Analyzes code for bugs, security vulnerabilities, and quality issues
- **Inline Comments** - Posts comments directly on problematic lines
- **QA Test Scenarios** - Suggests manual test cases based on code changes
- **Test Suggestions** - Recommends unit tests when new logic is added
- **Smart Verdicts** - Approves, requests changes, or flags PRs

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
| `openai-api-key` | OpenAI API key | Yes* | - |
| `azure-api-key` | Azure OpenAI API key | Yes* | - |
| `azure-endpoint` | Azure OpenAI endpoint | No | - |
| `azure-model` | Azure OpenAI model name | No | - |
| `ai-provider` | AI provider (`openai` or `azure`) | No | `openai` |
| `model` | Model to use | No | `gpt-4` |
| `min-severity` | Minimum severity to report | No | `warning` |
| `ignore-patterns` | Files to ignore (comma-separated) | No | `*.md,*.txt,...` |

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

### With Azure OpenAI

```yaml
- uses: mayurrawte/SherlockQA@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-provider: azure
    azure-api-key: ${{ secrets.AZURE_OPENAI_KEY }}
    azure-endpoint: https://your-resource.openai.azure.com
    azure-model: gpt-4
```

### Custom Configuration

```yaml
- uses: mayurrawte/SherlockQA@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    model: gpt-4-turbo
    min-severity: error
    ignore-patterns: "*.md,*.txt,docs/*,*.lock"
```

## Example Review

When SherlockQA reviews your PR, you'll see:

```markdown
## 🔍 SherlockQA's Review

### Summary
This PR adds user authentication with JWT tokens.

### 🧪 Tests Required
Add unit tests for token validation and expiration handling.

### 🎯 QA Test Scenarios
- [ ] Test login with invalid credentials
- [ ] Test token expiration after 24 hours
- [ ] Test concurrent sessions

### Verdict
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
