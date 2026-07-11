# Changelog

## [0.3.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.2.0...v0.3.0) (2026-07-11)


### Features

* sync with upstream claude-agent-acp v0.58.1 ([84e291f](https://github.com/lucascouts/claude-agent-acp-plus/commit/84e291f8151ea222f8f445b7abfadb3a9b8633a9))

## [0.2.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.1.1...v0.2.0) (2026-07-08)


### Features

* parity round 2 (port from fork) ([217011a](https://github.com/lucascouts/claude-agent-acp-plus/commit/217011a55b120735235600a83ab422ce26821473))

## [0.1.1](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.1.0...v0.1.1) (2026-07-08)


### Miscellaneous Chores

* **package:** describe the fork's value in the npm listing ([05cf597](https://github.com/lucascouts/claude-agent-acp-plus/commit/05cf59794f7ae365d83d063acbab001bf1409eaa))

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
