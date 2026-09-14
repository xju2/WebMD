import fs from 'node:fs/promises';
import { normalizeWorkspaceFolder, normalizeWorkspacePath } from './workspace.js';

export const SETTINGS_CONFIG_PATH = '/.webmd/settings.json';

export const DEFAULT_IMAGE_ASSET_FOLDER = '/assets';
export const DEFAULT_DAILY_NOTE_FOLDER = '/raw/dailynotes';

/**
 * Settings that describe how one workspace is laid out, so they live in the
 * workspace (`.webmd/settings.json`) and travel with its notes instead of
 * sitting in one browser or one server's config. They are set once and then
 * forgotten, which is why the UI has no controls for them.
 *
 *   imageAssetFolder   where pasted and uploaded files go. Falls back to
 *                      IMAGE_ASSET_FOLDER, then /assets.
 *   dailyNoteFolder    where daily notes live. Unset means /raw/dailynotes,
 *                      or / when the workspace has no such folder.
 *   dailyNoteTemplate  the note a new daily note starts from. Unset means a
 *                      conventionally named template; "" means none.
 *
 * A bad value is dropped with a warning naming it, and the rest still apply.
 */
export async function readWorkspaceSettings(workspace, env = {}) {
  const { values, warnings } = await readSettingsFile(workspace);

  const imageAssetFolder =
    folderSetting(values, 'imageAssetFolder', warnings) ??
    normalizeWorkspaceFolder(env.IMAGE_ASSET_FOLDER || DEFAULT_IMAGE_ASSET_FOLDER);
  const configuredFolder = folderSetting(values, 'dailyNoteFolder', warnings);

  return {
    imageAssetFolder,
    dailyNoteFolder: configuredFolder ?? DEFAULT_DAILY_NOTE_FOLDER,
    dailyNoteFolderConfigured: configuredFolder !== undefined,
    dailyNoteTemplate: templateSetting(values, warnings),
    ...(warnings.length ? { warning: warnings.join(' ') } : {})
  };
}

async function readSettingsFile(workspace) {
  // A read-only resolve: loading settings must not create .webmd/.
  let raw;
  try {
    const absolute = await workspace.resolvePath(SETTINGS_CONFIG_PATH);
    raw = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    // No settings file is the normal case: every default applies.
    if (error.code === 'ENOENT' || error.status === 404) {
      return { values: {}, warnings: [] };
    }
    if (error.status === 403) {
      return {
        values: {},
        warnings: [`${SETTINGS_CONFIG_PATH} resolves outside the workspace.`]
      };
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      values: {},
      warnings: [`${SETTINGS_CONFIG_PATH} is not valid JSON: ${error.message}`]
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      values: {},
      warnings: [`${SETTINGS_CONFIG_PATH} must hold a JSON object.`]
    };
  }
  return { values: parsed, warnings: [] };
}

function folderSetting(values, key, warnings) {
  const value = values[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim()) {
    try {
      return normalizeWorkspaceFolder(value.trim());
    } catch {
      // Falls through to the warning below.
    }
  }
  warnings.push(`Ignored "${key}" in ${SETTINGS_CONFIG_PATH}: not a workspace folder.`);
  return undefined;
}

function templateSetting(values, warnings) {
  const value = values.dailyNoteTemplate;
  if (value === undefined || value === null) return null;
  if (value === '') return '';
  if (typeof value === 'string' && /\.(md|markdown)$/i.test(value.trim())) {
    try {
      const trimmed = value.trim();
      return normalizeWorkspacePath(trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
    } catch {
      // Falls through to the warning below.
    }
  }
  warnings.push(
    `Ignored "dailyNoteTemplate" in ${SETTINGS_CONFIG_PATH}: not a Markdown note path.`
  );
  return null;
}
