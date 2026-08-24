# @deepseek-ai/dsh-client-ui-schedule

English | [中文](README.zh.md)

Session-header current-state board for durable Schedule reminders. The plugin contributes `schedule-list` to `conversation.session.header.actions` at order 30, immediately after background jobs. It activates only when the Client has the standard Session projection hook and the Host-mounted `remote.schedules` namespace.

The trigger is absent when the `schedules` projection is absent or empty. Its count includes scheduled and overdue records but excludes paused records; the nearest active target is shown beside the count. The board retains creation order and presents scheduled, overdue, and paused rows. Pause, resume, and delete call the Host Remote namespace; delete requires a second inline confirmation, and mutation errors stay on their row. Creation remains model-facing through `schedule_create`, so this package has no create form.

The package reads only the independent `schedules` Session projection. It never folds `schedule/change` in the browser and never infers reminder state from transcript or tool-call rendering. The Client clock derives scheduled versus overdue display from `scheduledAt`; the durable `paused` flag comes from the projection. Escape closes the board and restores trigger focus, a pointer press outside closes it, and an empty projection closes it before the action disappears. The board is portaled to the viewport, aligns its right edge to the trigger, and clamps leftward within the viewport so it remains visible in a narrow Side Chat.

The behavior is specified by the [Session Schedule board Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-session-schedule-board.md).

## Model Experience

None, as this human-facing current-state projection adds no tools, messages, prompts, or provider requests; pause and resume intentionally have no model-facing tools.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Live Session management only** — Remote mutations resolve the exact live root Agent; the board does not wake a cold Session or provide an external scheduler.
- **No delivery receipt** — scheduled, overdue, and paused are reminder-management states, not evidence that a follow-up model turn succeeded or was read.
