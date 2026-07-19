# Changelog

## [0.4.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.3.0...v0.4.0) (2026-07-19)


### Features

* port upstream v0.59.0 (configurable LLM providers, subagent fixes) ([#14](https://github.com/lucascouts/claude-agent-acp-plus/issues/14)) ([dd7dc4d](https://github.com/lucascouts/claude-agent-acp-plus/commit/dd7dc4d6a9c0aa54db4b438d46c378770e8e28e5))


### Security

* remove polynomial ReDoS (CWE-1333) in subagent trailer stripping ([#14](https://github.com/lucascouts/claude-agent-acp-plus/issues/14)) ([dd7dc4d](https://github.com/lucascouts/claude-agent-acp-plus/commit/dd7dc4d6a9c0aa54db4b438d46c378770e8e28e5))

  The `<usage>` / `agentId:` trailer patterns inherited from upstream v0.59.0
  were tail-anchored but not start-anchored, so the engine retried from every
  position — O(n²) on text repeating an opening token, which a subagent can
  echo verbatim into the `tool_result` its report is parsed from. Rewritten
  with index matching (constant-time on the same input), semantics verified
  identical against the original on 200k randomized cases.

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
