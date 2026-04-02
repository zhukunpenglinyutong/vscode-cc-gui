---

description: "Task list template for feature implementation"
---

# Tasks: [FEATURE NAME]

**Input**: Design documents from `/specs/[###-feature-name]/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Tests are REQUIRED. Every user story and parity slice must include automated verification and a manual smoke path.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Extension host**: `src/`
- **Webview**: `webview/src/`
- **Bridge**: `ai-bridge/`
- **Tests**: `src/test/host/`, `src/test/webview/`, `src/test/smoke/`
- Paths shown below assume the repository's host/webview/bridge structure - adjust if plan.md documents a justified variation

<!-- 
  ============================================================================
  IMPORTANT: The tasks below are SAMPLE TASKS for illustration purposes only.
  
  The /speckit.tasks command MUST replace these with actual tasks based on:
  - User stories from spec.md (with their priorities P1, P2, P3...)
  - Feature requirements from plan.md
  - Entities from data-model.md
  - Endpoints from contracts/
  
  Tasks MUST be organized by user story so each story can be:
  - Implemented independently
  - Tested independently
  - Delivered as an MVP increment
  
  DO NOT keep these sample tasks in the generated tasks.md file.
  ============================================================================
-->

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [ ] T001 Create extension host, webview, and bridge directories per plan
- [ ] T002 Initialize TypeScript, VS Code extension, and webview build dependencies
- [ ] T003 [P] Configure linting, formatting, and test scripts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

Examples of foundational tasks (adjust based on your project):

- [ ] T004 Create the webview panel host and HTML asset loader in `src/webview/host/`
- [ ] T005 [P] Define the frontend-host bridge event types in `src/webview/types/`
- [ ] T006 [P] Add the `ai-bridge` invocation service in `src/webview/services/`
- [ ] T007 Create shared storage/session service primitives used by all stories
- [ ] T008 Configure error handling, logging, and bridge output parsing
- [ ] T009 Add baseline automated tests for host activation and webview bridge compatibility

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - [Title] (Priority: P1) 🎯 MVP

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T010 [P] [US1] Host unit test for the new behavior in `src/test/host/[name].test.ts`
- [ ] T011 [P] [US1] Webview or smoke verification for the user journey in `src/test/webview/` or `src/test/smoke/`

### Implementation for User Story 1

- [ ] T012 [P] [US1] Implement the host adapter in `src/webview/handlers/` or `src/webview/services/`
- [ ] T013 [P] [US1] Implement the matching webview behavior in `webview/src/`
- [ ] T014 [US1] Wire the bridge contract between frontend and host
- [ ] T015 [US1] Add validation, error handling, and provider/session state updates
- [ ] T016 [US1] Update smoke checklist and documentation for the new parity slice
- [ ] T017 [US1] Run tests and capture manual verification evidence

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - [Title] (Priority: P2)

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 2 ⚠️

- [ ] T018 [P] [US2] Host unit test in `src/test/host/[name].test.ts`
- [ ] T019 [P] [US2] Webview or smoke verification in `src/test/webview/` or `src/test/smoke/`

### Implementation for User Story 2

- [ ] T020 [P] [US2] Extend the host storage or workspace service in `src/webview/services/`
- [ ] T021 [US2] Extend the matching handler in `src/webview/handlers/`
- [ ] T022 [US2] Update the webview feature in `webview/src/`
- [ ] T023 [US2] Integrate with previously delivered parity slices without changing approved UX

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - [Title] (Priority: P3)

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 3 ⚠️

- [ ] T024 [P] [US3] Host unit test in `src/test/host/[name].test.ts`
- [ ] T025 [P] [US3] Webview or smoke verification in `src/test/webview/` or `src/test/smoke/`

### Implementation for User Story 3

- [ ] T026 [P] [US3] Implement the advanced host adapter in `src/webview/handlers/`
- [ ] T027 [US3] Update the bridge/service flow needed by the advanced capability
- [ ] T028 [US3] Update the webview dialog, review, or orchestration UI in `webview/src/`

**Checkpoint**: All user stories should now be independently functional

---

[Add more user story phases as needed, following the same pattern]

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] TXXX [P] Documentation updates in docs/
- [ ] TXXX Code cleanup and refactoring
- [ ] TXXX Performance optimization across all stories
- [ ] TXXX [P] Additional unit and smoke tests in `src/test/`
- [ ] TXXX Security hardening
- [ ] TXXX Run manual VS Code smoke validation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - May integrate with US1 but should be independently testable
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - May integrate with US1/US2 but should be independently testable

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Host/service primitives before handler wiring
- Handler wiring before webview integration
- Core implementation before parity polish
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tasks marked [P] can run in parallel (within Phase 2)
- Once Foundational phase completes, all user stories can start in parallel (if team capacity allows)
- All tests for a user story marked [P] can run in parallel
- Models within a story marked [P] can run in parallel
- Different user stories can be worked on in parallel by different team members

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together (if tests requested):
Task: "Contract test for [endpoint] in tests/contract/test_[name].py"
Task: "Integration test for [user journey] in tests/integration/test_[name].py"

# Launch all models for User Story 1 together:
Task: "Create [Entity1] model in src/models/[entity1].py"
Task: "Create [Entity2] model in src/models/[entity2].py"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!)
3. Add User Story 2 → Test independently → Deploy/Demo
4. Add User Story 3 → Test independently → Deploy/Demo
5. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1
   - Developer B: User Story 2
   - Developer C: User Story 3
3. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently in VS Code
- Avoid: vague tasks, same file conflicts, silent rewrites of shared UI, or undocumented JetBrains-only gaps
