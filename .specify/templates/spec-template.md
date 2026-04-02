# Feature Specification: [FEATURE NAME]

**Feature Branch**: `[###-feature-name]`  
**Created**: [DATE]  
**Status**: Draft  
**Input**: User description: "$ARGUMENTS"

## Parity Scope *(mandatory for migration work)*

**Source Implementation**: [absolute path, module, or workflow being matched]  
**Reuse Targets**: [shared webview files, bridge modules, contracts, or assets to preserve]  
**In Scope For This Slice**: [specific behaviors delivered now]  
**Explicit Exclusions**: [JetBrains-only or intentionally deferred behavior]

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.
  
  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently
-->

### User Story 1 - [Brief Title] (Priority: P1)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently in VS Code and what parity value it proves]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]
2. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 2 - [Brief Title] (Priority: P2)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 3 - [Brief Title] (Priority: P3)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

[Add more user stories as needed, each with an assigned priority]

### Edge Cases

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right edge cases.
-->

- What happens when no workspace folder is open?
- How does the feature behave when the shared provider bridge is unavailable?
- What happens when the source IDEA behavior depends on a JetBrains-only API?
- How does the system restore state after a VS Code window reload?

## Requirements *(mandatory)*

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right functional requirements.
-->

### Functional Requirements

- **FR-001**: System MUST identify the source feature or workflow being matched.
- **FR-002**: System MUST state which existing UI or bridge modules are reused unchanged, adapted, or excluded.
- **FR-003**: Users MUST be able to complete the slice in VS Code without needing JetBrains-specific behaviors.
- **FR-004**: System MUST persist or restore any state required for the slice to feel continuous in VS Code.
- **FR-005**: System MUST define the automated and manual verification path for the slice.

*Example of marking unclear requirements:*

- **FR-006**: System MUST adapt [NEEDS CLARIFICATION: exact IDEA workflow or screen not yet identified]
- **FR-007**: System MUST preserve [NEEDS CLARIFICATION: state, event contract, or provider behavior not yet specified]

### Key Entities *(include if feature involves data)*

- **[Entity 1]**: [What it represents, key attributes without implementation]
- **[Entity 2]**: [What it represents, relationships to other entities]

## Success Criteria *(mandatory)*

<!--
  ACTION REQUIRED: Define measurable success criteria.
  These must be technology-agnostic and measurable.
-->

### Measurable Outcomes

- **SC-001**: The described slice works in VS Code and passes the defined automated verification.
- **SC-002**: The preserved workflow matches the source implementation closely enough to avoid a UI redesign for this slice.
- **SC-003**: Any remaining JetBrains-only gap is explicitly documented as excluded or deferred.
- **SC-004**: The slice can be demonstrated through a manual smoke run inside VS Code.

## Assumptions

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right assumptions based on reasonable defaults
  chosen when the feature description did not specify certain details.
-->

- [Assumption about available VS Code APIs or extension host capabilities]
- [Assumption about which source product behavior is the parity baseline]
- [Assumption about reusable webview or `ai-bridge` assets]
- [Assumption about deferred or excluded IDE-specific behavior]
