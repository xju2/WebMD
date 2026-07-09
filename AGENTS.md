# Agent Instructions

- After making code or documentation changes, run the smallest relevant check that can catch breakage.
- Automatically commit the changes made for the current task before the final response.
- Stage only task-related files. If unrelated dirty files already exist, leave them unstaged and mention them.
- Use a concise commit message that describes the user-visible change.
- Do not commit generated build output, secrets, local logs, or temporary files unless the user explicitly asks.
