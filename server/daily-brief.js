import { WorkspaceError } from './workspace.js';

export const DAILY_BRIEF_PATH = '/raw/dailybrief/latest.md';

export function dailyBriefPathForDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `/raw/dailybrief/${year}-${month}-${day}.md`;
}

export async function readDailyBrief(workspace, date = new Date()) {
  const todayPath = dailyBriefPathForDate(date);

  for (const briefPath of [todayPath, DAILY_BRIEF_PATH]) {
    try {
      const file = await workspace.loadFile(briefPath);
      return { path: briefPath, content: file.content };
    } catch (error) {
      if (error instanceof WorkspaceError && error.status === 404) continue;
      throw error;
    }
  }

  return { path: todayPath, content: '' };
}
