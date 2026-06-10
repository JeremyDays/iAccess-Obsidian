# Uebergabe: iAccess Obsidian-Website

## Zentrale Quelle

Generator, Darstellungsregeln und Aktualisierungsablauf liegen zentral im
GitHub-Repository:

- Repository: `https://github.com/JeremyDays/iAccess-Obsidian`
- Live-Seite: `https://jeremydays.github.io/iAccess-Obsidian/`
- Branch: `main`
- Default-Seite: `notes/projektphasen.html`

```text
iAccess Publish\
`-- .github\
    `-- iaccess-tooling\             # bleibt auch bei alten Exportskripten erhalten
        |-- scripts\
        |-- assets\
        |-- Website aktualisieren.ps1
        |-- Website aktualisieren.cmd
        `-- CODEX-UEBERGABE-iAccess-Website.md
```

Aenderungen an Generator oder Regeln werden ausschliesslich in
`iAccess Publish\.github\iaccess-tooling` vorgenommen und nach GitHub gepusht. Vor jedem Export
holt das Skript mit `git pull --ff-only` den zentralen Stand. Dadurch verwenden
beide Rechner dieselbe Version.

## Was lokal bleibt

- Obsidian-Vault und Relay-Daten
- Git-Anmeldung beziehungsweise GitHub-Token
- optional ein kleiner Starter ausserhalb des Repositorys

Vault, Token und andere Geheimnisse duerfen niemals committed werden.

Der standardmaessige Vault-Pfad ist:

```text
%USERPROFILE%\Documents\iAccess\Shared
```

Nur dieser Ordner wird veroeffentlicht. Die CSS-Snippets werden aus
`%USERPROFILE%\Documents\iAccess\.obsidian\snippets` gelesen.

## Einrichtung eines weiteren Rechners

1. Git for Windows und Node.js LTS installieren.
2. Die Vault mit Relay vollstaendig synchronisieren.
3. Das Repository klonen:

```powershell
cd "$env:USERPROFILE\Documents\Obsidian Database"
git clone https://github.com/JeremyDays/iAccess-Obsidian.git "iAccess Publish"
```

4. GitHub-Anmeldung ueber Git Credential Manager durchfuehren.
5. `iAccess Publish\.github\iaccess-tooling\Website aktualisieren.cmd`
   doppelklicken.

Es muss kein separater Ordner `iAccess Website` mehr kopiert oder gepflegt
werden.

## Aktualisierungsablauf

1. Pruefen, ob das Repository sauber ist.
2. Zentralen Stand mit `git pull --ff-only origin main` holen.
3. Projektphasen aus der Vault-Ordnerstruktur aktualisieren.
4. `Shared` mit `.github\iaccess-tooling\scripts\export-vault.mjs` exportieren.
5. Nachbearbeitung mit `.github\iaccess-tooling\scripts\postprocess-site.mjs`
   ausfuehren.
6. Erzeugte Website ins Repository uebernehmen; `.github` und damit Generator
   und Starter bleiben erhalten.
7. Commit erstellen und nach `main` pushen.
8. GitHub Pages veroeffentlicht die Seite.

## Dashboard-Regeln

- `Projekte gesamt` umfasst auch Projekte unter `z_Cancelled` und als
  `nicht gebaut` gekennzeichnete Projekte.
- Wiki- und Hilfsnotizen unter `Projekte/z_Ergaenzendes` werden nicht als
  Projekte gezaehlt.
- Die eigene Dashboard-Kachel `Aufgegeben` wird nicht angezeigt.

## Sicherheit und Konflikte

- Vor jeder Veroeffentlichung muss Relay vollstaendig synchronisiert sein.
- Das Skript bricht bei uncommitteten Repository-Aenderungen ab.
- Ein nicht moeglicher Fast-Forward wird nicht automatisch ueberschrieben.
- Relay-Konfliktdateien muessen vor dem Export verglichen werden.
- Formspree-Kommentare aendern weder Vault noch Website.
- Formspree-Endpunkt: `https://formspree.io/f/xgobklaa`
- Empfaenger: `hornick@iaccess.de`

## Wichtige Dateien

```text
.github\iaccess-tooling\scripts\export-vault.mjs
.github\iaccess-tooling\scripts\postprocess-site.mjs
.github\iaccess-tooling\scripts\sync-project-phases.mjs
.github\iaccess-tooling\assets\iaccess-logo.png
.github\iaccess-tooling\Website aktualisieren.ps1
.github\iaccess-tooling\Website aktualisieren.cmd
```

`export-vault.mjs` enthaelt unter anderem:

- Ausschluss nicht freigegebener Ordner und Notizen
- Dashboard-Berechnung
- Obsidian- und Meta-Bind-Darstellung
- Projektphasen und Projektkarten
- Ordnernavigation, Suche und Hover-Vorschau
- Formspree-Kommentarformular
- Einbindung der Obsidian-CSS-Snippets

Git versioniert Generator und erzeugte Website. Die Vault selbst wird weiterhin
durch Relay synchronisiert und besitzt dadurch keine mit Git vergleichbare
Konflikt- und Versionshistorie.
