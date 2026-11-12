# Agent Instructions

- After making code or documentation changes, run the smallest relevant check that can catch breakage.
- Automatically commit the changes made for the current task before the final response.
- Stage only task-related files. If unrelated dirty files already exist, leave them unstaged and mention them.
- Use a concise commit message that describes the user-visible change.
- Do not commit generated build output, secrets, local logs, or temporary files unless the user explicitly asks.
- The app runs permanently under launchd as `com.webmd` (`npm run dev`; plist in `deploy/com.webmd.plist`, log in `~/Library/Logs/webmd/dev.log`). Do not start `npm run dev` yourself. Vite hot-reloads the client and `node --watch` restarts the server on file changes; if anything else needs a restart (dependencies, `vite.config.js`, `~/.webmd.conf`), run `launchctl kickstart -k gui/$(id -u)/com.webmd`.
- No need to use worktree, since you are the only developer. You can commit directly to the main branch.