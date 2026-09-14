---
title: Workspace settings
tags: [guide]
---

# Workspace settings

Each workspace keeps its own configuration in a hidden `.webmd/` folder, so
the settings travel with the notes.

- `.webmd/settings.json` sets the image folder, the daily-note folder, and the
  daily-note template. This sandbox uses `/assets`, `/daily`, and
  `/daily/template.md`.
- `.webmd/prompts.json` adds your own prompts to the AI panel. This sandbox
  adds one, **Plain English**.
- `.webmd/news.md` describes your research so arXiv News can rank papers for
  you.

There are no controls for these in the UI. Edit the files, then reload the
page. Keys, secrets, and the list of workspaces stay on the server, in
`~/.webmd.conf`.
