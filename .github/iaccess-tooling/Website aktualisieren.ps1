[CmdletBinding()]
param(
    [string]$VaultPath = (Join-Path $env:USERPROFILE "Documents\iAccess\Shared"),
    [string]$WebsitePath = "",
    [string]$PublishPath = "",
    [switch]$Yes
)

$ErrorActionPreference = "Stop"

if (-not $PublishPath) {
    $PublishPath = Join-Path $PSScriptRoot "..\.."
}
if (-not $WebsitePath) {
    $WebsitePath = $PSScriptRoot
}

function Resolve-RequiredPath {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Description wurde nicht gefunden: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Find-Executable {
    param(
        [Parameter(Mandatory)]
        [string]$Name,
        [string[]]$Candidates = @()
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw "$Name wurde nicht gefunden. Bitte zuerst installieren und danach dieses Fenster neu starten."
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [Parameter(Mandatory)]
        [string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Befehl fehlgeschlagen ($LASTEXITCODE): $FilePath $($Arguments -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

try {
    Write-Host ""
    Write-Host "iAccess Obsidian-Website aktualisieren" -ForegroundColor Cyan
    Write-Host "====================================" -ForegroundColor Cyan
    Write-Host ""

    $vault = Resolve-RequiredPath -Path $VaultPath -Description "Der freigegebene Vault-Ordner"
    $website = Resolve-RequiredPath -Path $WebsitePath -Description "Der Website-Generator"
    $publish = Resolve-RequiredPath -Path $PublishPath -Description "Das GitHub-Publish-Repository"

    $nodeCandidates = @(
        (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
    )
    $node = Find-Executable -Name "node" -Candidates $nodeCandidates
    $git = Find-Executable -Name "git" -Candidates @(
        (Join-Path $env:ProgramFiles "Git\cmd\git.exe")
    )

    if (-not $Yes) {
        Write-Host "Vault:   $vault"
        Write-Host "Website: $website"
        Write-Host ""
        Write-Host "Wichtig: Relay muss auf diesem Rechner vollstaendig synchronisiert sein." -ForegroundColor Yellow
        $answer = Read-Host "Ist Relay fertig und ist diese Vault-Version die aktuelle? (J/N)"
        if ($answer -notmatch "^[JjYy]") {
            Write-Host "Abgebrochen. Es wurde nichts veraendert." -ForegroundColor Yellow
            exit 0
        }
    }

    $gitDirectory = Join-Path $publish ".git"
    if (-not (Test-Path -LiteralPath $gitDirectory -PathType Container)) {
        throw "Im Publish-Ordner fehlt das Git-Repository: $gitDirectory"
    }

    # Repository-lokale Einstellungen: keine globale Git-Konfiguration verändern.
    Invoke-Checked -FilePath $git -Arguments @("-C", $publish, "config", "user.name", "iAccess Website Publisher") -WorkingDirectory $PSScriptRoot
    Invoke-Checked -FilePath $git -Arguments @("-C", $publish, "config", "user.email", "hornick@iaccess.de") -WorkingDirectory $PSScriptRoot
    Invoke-Checked -FilePath $git -Arguments @("-C", $publish, "config", "core.autocrlf", "false") -WorkingDirectory $PSScriptRoot
    Invoke-Checked -FilePath $git -Arguments @("-C", $publish, "config", "core.eol", "lf") -WorkingDirectory $PSScriptRoot

    $pending = & $git -C $publish status --porcelain
    if ($LASTEXITCODE -ne 0) {
        throw "Der Git-Status konnte nicht gelesen werden."
    }
    if ($pending) {
        throw "Im Publish-Repository liegen noch nicht abgeschlossene Aenderungen. Bitte zuerst mit Codex pruefen: $publish"
    }

    Write-Host ""
    Write-Host "1/5 Zentralen Website- und Regelstand von GitHub holen ..." -ForegroundColor Cyan
    Invoke-Checked -FilePath $git -Arguments @("-C", $publish, "pull", "--ff-only", "origin", "main") -WorkingDirectory $PSScriptRoot

    Write-Host "2/5 Projektphasen aus der Ordnerstruktur aktualisieren ..." -ForegroundColor Cyan
    Invoke-Checked -FilePath $node -Arguments @("scripts\sync-project-phases.mjs", $vault, "--apply") -WorkingDirectory $website

    Write-Host "3/5 Website aus Shared exportieren ..." -ForegroundColor Cyan
    Invoke-Checked -FilePath $node -Arguments @("scripts\export-vault.mjs", $vault) -WorkingDirectory $website

    $public = Resolve-RequiredPath -Path (Join-Path $website "public") -Description "Der erzeugte Website-Ordner"
    Invoke-Checked -FilePath $node -Arguments @("scripts\postprocess-site.mjs", $public) -WorkingDirectory $website
    $repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
    if (-not $publish.Equals($repositoryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Sicherheitspruefung fehlgeschlagen: Der Publish-Ordner ist nicht das zentrale Repository."
    }

    Write-Host "4/5 Erzeugte Website in das Publish-Repository uebernehmen ..." -ForegroundColor Cyan
    Get-ChildItem -LiteralPath $publish -Force |
        Where-Object { $_.Name -notin @(".git", ".github") } |
        Remove-Item -Recurse -Force
    Get-ChildItem -LiteralPath $public -Force |
        Copy-Item -Destination $publish -Recurse -Force

    Invoke-Checked -FilePath $git -Arguments @("-C", $publish, "add", "--all") -WorkingDirectory $PSScriptRoot
    & $git -C $publish diff --cached --quiet
    $diffExitCode = $LASTEXITCODE
    if ($diffExitCode -eq 0) {
        Write-Host ""
        Write-Host "Die Website ist bereits aktuell. Es wurde nichts veroeffentlicht." -ForegroundColor Green
        exit 0
    }
    if ($diffExitCode -ne 1) {
        throw "Die vorbereiteten Git-Aenderungen konnten nicht geprueft werden."
    }

    Write-Host "5/5 Commit erstellen und zu GitHub pushen ..." -ForegroundColor Cyan
    $commitMessage = "Update iAccess website $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    Invoke-Checked -FilePath $git -Arguments @("-C", $publish, "commit", "-m", $commitMessage) -WorkingDirectory $PSScriptRoot
    Invoke-Checked -FilePath $git -Arguments @("-C", $publish, "push", "origin", "main") -WorkingDirectory $PSScriptRoot

    Write-Host ""
    Write-Host "Fertig. GitHub Pages aktualisiert die Website normalerweise innerhalb weniger Minuten." -ForegroundColor Green
    Write-Host "https://jeremydays.github.io/iAccess-Obsidian/"
}
catch {
    Write-Host ""
    Write-Host "Aktualisierung abgebrochen:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
