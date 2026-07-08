# Security Policy

## Supported Versions

Only the latest published release of `@lucascouts/claude-agent-acp-plus` is
supported with security fixes.

| Version        | Supported |
| -------------- | --------- |
| latest release | ✅        |
| older releases | ❌        |

## Reporting a Vulnerability

**Do not open a public issue for security reports.**

Use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/lucascouts/claude-agent-acp-plus/security/advisories/new).

You can expect an acknowledgement within 7 days. Please include a minimal
reproduction, the affected version, and the impact you foresee. Coordinated
disclosure is appreciated — give us a chance to ship a fix before publishing
details.

## Scope

This project is an [ACP](https://agentclientprotocol.com) adapter that runs
locally and spawns the Claude CLI (vendored by the Claude Agent SDK). In scope:

- The adapter code in this repository (`src/`, published `dist/`).
- The release/publish pipeline of this repository (workflows, provenance).

Out of scope (report upstream instead):

- The Claude Agent SDK and the Claude CLI — [Anthropic](https://www.anthropic.com/responsible-disclosure-policy).
- The upstream adapter this fork is based on — [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp).
- ACP clients (e.g. Zed).

## Supply-chain posture

- npm packages are published from CI via OIDC trusted publishing with
  provenance attestations.
- Dependencies are pinned via `package-lock.json` and installed with `npm ci`.
- Dependabot runs with a release cooldown so brand-new package versions are
  not adopted immediately.
- GitHub Actions are pinned to full commit SHAs.
- CI runs secret scanning (gitleaks), dependency vulnerability scanning
  (OSV-Scanner), and `npm audit`.
