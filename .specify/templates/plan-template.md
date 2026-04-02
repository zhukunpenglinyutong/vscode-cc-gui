# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]
**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Parity Target

**Source Implementation**: [absolute path, module, or artifact being matched]  
**Reuse Targets**: [shared webview modules, bridge modules, contracts to preserve]  
**Explicit Exclusions**: [JetBrains-only or otherwise out-of-scope behavior]  
**Phase Target**: [Phase 1 shell/streaming, Phase 2 fidelity, Phase 3 advanced flows]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., TypeScript 5.x, Node 22.x]  
**Primary Dependencies**: [e.g., VS Code Extension API, React, Vite, ai-bridge modules]  
**Storage**: [e.g., VS Code globalState/workspaceState, provider history files, local metadata]  
**Testing**: [e.g., Vitest, @vscode/test-electron, webview component tests]  
**Target Platform**: [VS Code desktop extension on macOS/Windows/Linux]  
**Project Type**: [desktop extension with embedded webview + Node bridge]  
**Performance Goals**: [e.g., sidebar open under 1s, streamed tokens appear incrementally]  
**Constraints**: [e.g., preserve approved UI flow, avoid JetBrains-only assumptions, phase-gated delivery]  
**Scale/Scope**: [e.g., parity slice, host-only migration, or full feature family]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [ ] Preserves the approved interaction model until parity for this slice is working
- [ ] Reuses existing webview and/or `ai-bridge` logic before introducing rewrites
- [ ] Isolates IDE-specific behavior behind a typed VS Code host adapter
- [ ] Documents explicit exclusions for JetBrains-only behavior
- [ ] Defines automated tests and a manual smoke path for this slice

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
src/
├── extension.ts
├── webview/
│   ├── host/
│   ├── handlers/
│   ├── services/
│   └── types/
└── test/
    ├── host/
    ├── webview/
    └── smoke/

webview/
└── src/

ai-bridge/
└── ...

docs/superpowers/
├── specs/
└── plans/
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., temporary compatibility shim] | [current migration need] | [why a full rewrite would slow parity] |
| [e.g., duplicate protocol type] | [bridge adaptation need] | [why immediate shared-package extraction is premature] |
