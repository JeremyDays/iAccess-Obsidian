# iAccess Website Tooling

Dieser Ordner ist die zentrale, in GitHub versionierte Quelle fuer die
Website-Erstellung. Beide Rechner verwenden direkt diese Dateien. Lokale
Generator-Kopien werden nicht separat gepflegt.

Der normale Einstieg ist:

```text
Website aktualisieren.cmd
```

Manueller Export:

```powershell
node scripts\sync-project-phases.mjs "$env:USERPROFILE\Documents\iAccess\Shared" --apply
node scripts\export-vault.mjs "$env:USERPROFILE\Documents\iAccess\Shared"
node scripts\postprocess-site.mjs public
```

Der erzeugte Ordner `public` wird durch `.gitignore` ausgeschlossen. Vault,
GitHub-Token und andere Geheimnisse duerfen niemals in dieses Repository
geschrieben werden.
