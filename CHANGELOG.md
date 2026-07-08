# Changelog

## 0.1.0 (2026-07-08)

Initial release of `@lucascouts/claude-agent-acp-plus`, rebased on upstream
[claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
v0.57.0.

### Highlights

- Refusal-fallback consent dialog inherited from upstream v0.55.0.
- AskUserQuestion permission fallback (multiSelect → checkbox).
- Dynamic agent name derived from package.json.
- Dependencies at latest workable versions: all devDependencies at registry
  latest; runtime SDKs kept at the upstream v0.57.0 pins after breakage
  attribution.
