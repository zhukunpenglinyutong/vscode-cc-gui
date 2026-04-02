<!--
Sync Impact Report
Version change: template -> 1.0.0
Modified principles:
- Principle 1 placeholder -> I. Compatibility Before Reinvention
- Principle 2 placeholder -> II. Reuse Shared UI And Bridge First
- Principle 3 placeholder -> III. Verification-Gated Delivery
- Principle 4 placeholder -> IV. Explicit Host Boundaries
- Principle 5 placeholder -> V. Incremental Parity, Then Optimization
Added sections:
- Migration Boundaries
- Delivery Workflow And Quality Gates
Removed sections:
- None
Templates requiring updates:
- ✅ /Users/zhukunpeng/Desktop/vscode-cc-gui/.specify/templates/plan-template.md
- ✅ /Users/zhukunpeng/Desktop/vscode-cc-gui/.specify/templates/spec-template.md
- ✅ /Users/zhukunpeng/Desktop/vscode-cc-gui/.specify/templates/tasks-template.md
Follow-up deferred items:
- None
-->
# VS Code CC GUI Constitution

## Core Principles

### I. Compatibility Before Reinvention
The project MUST preserve the approved single-sidebar information architecture and the established
message, settings, history, and session interaction model until functional parity is working in VS
Code. UI redesign, workflow simplification, or information-architecture changes MAY happen only
after the preserved behavior is runnable and verified. This keeps the migration measurable and
prevents style changes from hiding functional regressions.

### II. Reuse Shared UI And Bridge First
The existing React webview and Node `ai-bridge` are the primary reuse surfaces. New work MUST
prefer adapting those assets before rewriting them, and any rewrite MUST document why reuse was not
sufficient. Shared provider protocols, event names, and data contracts MUST remain stable unless a
documented migration updates every dependent layer. This minimizes host-porting risk and avoids
forking product behavior across platforms.

### III. Verification-Gated Delivery
Every migration step MUST ship with automated verification and a manual smoke path before it is
considered complete. Host services require unit tests, webview bridge changes require frontend
tests, and every parity phase requires an end-to-end manual checklist in VS Code. No phase may be
declared finished on visual similarity alone; runnable behavior and verification evidence are
required.

### IV. Explicit Host Boundaries
IDE-specific APIs MUST be isolated behind typed host adapters. VS Code code MUST not absorb
JetBrains assumptions such as JCEF callbacks, PSI services, or Swing lifecycle directly into shared
logic. If a source capability is JetBrains-specific and lacks a reasonable VS Code equivalent, the
plan MUST mark it as an explicit exclusion rather than quietly approximating it. This keeps the
shared layers portable and makes non-parity decisions auditable.

### V. Incremental Parity, Then Optimization
Migration work MUST be planned and executed in independent parity slices that produce a runnable
product after each phase. Phase 1 establishes shell and streaming chat, Phase 2 restores workspace
and session fidelity, and later phases add safety and advanced flows such as diff review,
permissions, MCP, and agents. Performance tuning, refactors, and VS Code-native UX improvements
MUST wait until the corresponding parity slice works correctly.

## Migration Boundaries

Every spec and plan MUST include the following:

- the source feature or workflow being matched
- the exact reuse target in the existing IDEA implementation
- the VS Code host adapter responsible for the feature
- the explicit exclusions for JetBrains-only behavior
- the verification path for preserved or adapted behavior

The repository's preferred shape is:

```text
src/                # VS Code extension host and adapters
webview/            # React webview UI
ai-bridge/          # Shared provider bridge
docs/superpowers/   # Design and implementation planning artifacts
```

Changes that span more than one layer MUST state the contract between the layers before
implementation begins.

## Delivery Workflow And Quality Gates

Design work MUST produce an approved design document before major implementation begins. Multi-step
execution MUST also produce an implementation plan with exact file ownership, phase ordering, and
verification commands. Tasks MUST be small enough to validate independently and MUST end in a
passing state before the next task builds on them.

The minimum quality gate for a parity milestone is:

- host unit tests pass
- relevant webview tests pass
- the extension builds successfully
- a manual VS Code smoke run is documented and completed
- any remaining gap is listed as deferred or excluded, not silently skipped

## Governance

This constitution governs repository planning, implementation, and review. It complements
`AGENTS.md`; when direct user instructions or `AGENTS.md` operational safety rules are more
specific, those instructions take precedence during execution.

Amendments require:

1. an updated design or planning artifact describing the change
2. a semantic-version decision for the constitution itself
3. synchronization of affected templates in `.specify/templates/`
4. an updated Sync Impact Report at the top of this file

Versioning policy:

- MAJOR: removes or fundamentally redefines a core migration principle
- MINOR: adds a new principle, section, or mandatory delivery gate
- PATCH: clarifies wording without changing required behavior

Compliance review expectations:

- every plan MUST pass the Constitution Check before implementation
- every review MUST call out violations or justified exceptions
- every completed phase MUST show verification evidence before parity claims are made

**Version**: 1.0.0 | **Ratified**: 2026-04-02 | **Last Amended**: 2026-04-02
