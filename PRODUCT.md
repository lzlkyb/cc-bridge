# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

React Web UI hosted in the existing Tauri desktop application. This record does not propose a platform or stack change.

## Product Purpose

CC Bridge provides a desktop workspace for remote access, terminal work, security controls, logs, and Claude Code conversations. The existing product name and capabilities are the authority for this record.

## Operating Context

The conversation surface supports local and SSH targets, working directories, multiple sessions, stored history, model selection, and permission modes. Terminal work remains a separate workspace.

## Capabilities and Constraints

- Existing conversation features include streamed replies, tool output, approvals, questions, message queues, drafts, Markdown, image input, search, and conversation forks.
- Conversation editing can create a new session; it is not a rollback of file changes. Historical image thumbnails do not imply that original images are available for resending.
- The application already implements classic and glass appearances with light and dark variants. A page upgrade must respect the selected application appearance.

## Confirmed Current Priority

On 2026-10-27 the user requested a comprehensive conversation-page upgrade, prioritizing everyday chat efficiency and consistency with the overall application. After approving the interactive prototype, the user authorized production implementation. The workspace upgrade is now implemented in the desktop source, extending the existing appearance system. The implemented scope and remaining proposal differences are recorded in [the implementation and acceptance record](docs/对话页升级实施与验收-2026-10-27.md).

## Evidence on Hand

Evidence includes the desktop source, the original application observations, the approved prototype under `design/`, production unit tests and build checks, and the browser report under `.impeccable/review/chat-production/`. The production browser fixture uses real components with simulated IPC; it does not establish live model/backend behavior, a packaged release, or installed-app acceptance. The original proposal remains a historical statement of intent, not a claim that every recommendation was implemented.

## Open Decisions

Broader audience segmentation and a redesign of the whole application have not been requested or established in this task.
