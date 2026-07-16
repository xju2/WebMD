import { WorkspaceError } from './workspace.js';

export const DAILY_BRIEF_PATH = '/raw/dailybrief/latest.md';

export async function readDailyBrief(workspace) {
  try {
    const file = await workspace.loadFile(DAILY_BRIEF_PATH);
    return { path: DAILY_BRIEF_PATH, content: file.content };
  } catch (error) {
    if (error instanceof WorkspaceError && error.status === 404) {
      return { path: DAILY_BRIEF_PATH, content: '' };
    }
    throw error;
  }
}
