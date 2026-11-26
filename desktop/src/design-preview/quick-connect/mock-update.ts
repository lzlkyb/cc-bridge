const noop = () => {};
const state = { status: "idle", update: null, progress: 0, progressIndeterminate: false, bytesPerSec: 0, downloadedBytes: 0, totalBytes: null,
  restarting: false, autoRestartIn: null, error: null, manualCheck: false, cancelAutoRestart: noop, checkForUpdate: noop, manualCheckForUpdate: noop,
  downloadAndInstall: noop, restart: noop, openUpdateNotes: noop, dismissUpdate: noop, isDismissed: () => false, acknowledgeUptodate: noop,
  autoPreload: true, setAutoPreload: noop, installPreparedUpdate: noop };
export const useUpdate = () => state;
export const useOptionalUpdate = useUpdate;
export const AUTO_RESTART_DELAY_SECS = 8;
export const friendlyError = (raw: string) => ({ friendly: raw, raw });
