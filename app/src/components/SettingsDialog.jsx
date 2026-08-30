import { ArtistManager } from "./ArtistManager.jsx";
import { SettingsHome } from "./SettingsHome.jsx";

export function SettingsDialog({
  mode = "home",
  releases,
  identityState,
  onChangeIdentityState,
  onOpenArtistManager,
  duplicateGroupCount,
  duplicateReleaseCount,
  onOpenDuplicateManager,
  onOpenSync,
  onBack,
  onClose,
  onExport,
  backupText,
  onMergeBackup,
  onRestore,
  onToast,
  onApplyCoverUpdates,
  readOnly = false,
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className={`settings-dialog${
          mode === "artists" ? " artist-settings-dialog" : ""
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {mode === "artists" ? (
          <ArtistManager
            releases={releases}
            identityState={identityState}
            onChange={onChangeIdentityState}
            onBack={onBack}
            onClose={onClose}
            onToast={onToast}
          />
        ) : (
          <SettingsHome
            releases={releases}
            identityState={identityState}
            onOpenArtistManager={onOpenArtistManager}
            duplicateGroupCount={duplicateGroupCount}
            duplicateReleaseCount={duplicateReleaseCount}
            onOpenDuplicateManager={onOpenDuplicateManager}
            onOpenSync={onOpenSync}
            onClose={onClose}
            onExport={onExport}
            backupText={backupText}
            onMergeBackup={onMergeBackup}
            onRestore={onRestore}
            onToast={onToast}
            onApplyCoverUpdates={onApplyCoverUpdates}
            readOnly={readOnly}
          />
        )}
      </section>
    </div>
  );
}
