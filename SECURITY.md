# Security Policy

## Supported Versions

SherlockQA follows semantic versioning. Security fixes are backported to the latest minor of each supported major.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Data handling

SherlockQA is a GitHub Action. It runs entirely inside your GitHub Actions runner. Specifically:

- **What it reads:** the PR diff and the list of changed files via the GitHub API, using the `github-token` you supply.
- **What it sends out:** the diff and the system prompt are sent to the AI provider you configure (`openai`, `anthropic`, `gemini`, `azure`, `azure-responses`, or `ollama`).
- **What it does not do:** SherlockQA does not transmit code or metadata to any SherlockQA-operated service. There is no SherlockQA backend.
- **Where your data ends up:** subject entirely to the data-handling policy of your chosen AI provider. For self-hosted Ollama, the diff never leaves your network.

If you are reviewing this for compliance, the relevant entry points are:
- AI calls: `callOpenAI`, `callAzureOpenAI`, `callAzureResponsesAPI`, `callAnthropic`, `callGemini`, `callOllama` in `src/index.js`.
- GitHub API calls: `octokit.rest.pulls.*`, `octokit.rest.issues.*`, `octokit.rest.checks.*` in `src/index.js`.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/mayurrawte/SherlockQA/security/advisories) of this repository.
2. Click **Report a vulnerability**.
3. Fill in what you found and how to reproduce it.

You can expect:

- **Acknowledgement** within 72 hours.
- **Initial assessment** within 7 days.
- **Patched release** within 30 days for confirmed vulnerabilities, or earlier for critical issues.

If GitHub private vulnerability reporting is not available to you, you may also email the maintainer directly — please mark the subject line `[SECURITY] SherlockQA`.

## Hardening your workflow

A few things you can do to reduce blast radius if SherlockQA (or any third-party Action) is ever compromised:

- **Pin by SHA, not by tag.** Use `uses: mayurrawte/SherlockQA@<full-commit-sha>` instead of `@v1`. Trades convenience for reproducibility.
- **Use a fine-scoped `GITHUB_TOKEN`.** Only grant `contents: read`, `pull-requests: write`, and (optionally) `checks: write`.
- **Avoid `pull_request_target` with checked-out PR code.** If you must support fork PRs, do not check out the fork's code with elevated permissions.
- **Store API keys as repo or org secrets**, never inline.
- **Review the diff of any version bump.** `dist/index.js` is the actual runtime — diff it.

## Out of scope

The following are not considered vulnerabilities in SherlockQA itself:

- Issues in upstream AI providers (OpenAI, Anthropic, Google, Azure).
- Hallucinated review comments that don't reflect real issues. The AI is fallible; this is a known limitation, not a security bug.
- The default model being on a remote provider. Use the `ollama` provider for fully local operation.
