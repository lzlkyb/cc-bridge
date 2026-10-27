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

On 2026-10-27 the user requested a comprehensive conversation-page upgrade proposal, prioritizing everyday chat efficiency and consistency with the overall application. This request is for a proposal; implementation is a subsequent step.

## Evidence on Hand

The current desktop source, the running application's connection and conversation pages, and existing design artifacts under `design/`. The proposal is not evidence of completed implementation or usability testing.

## Open Decisions

Broader audience segmentation and a redesign of the whole application have not been requested or established in this task.
