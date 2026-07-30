<#
  setup-iis-site.ps1
  Creates the IIS application pool + website for SQL Management (iisnode hosting)
  and grants the app-pool identity the file permissions iisnode needs.

  Run from an ELEVATED PowerShell prompt (Run as Administrator) AFTER you have
  installed: Node.js, IIS, the iisnode module, and the URL Rewrite module.
  (See IIS-HOSTING-GUIDE.md.)

  Usage:
    powershell -ExecutionPolicy Bypass -File .\deploy\setup-iis-site.ps1 `
        -SiteName "SQLConnect" -HostName "sql.yourcompany.local" -Port 80
#>

[CmdletBinding()]
param(
    [string]$SiteName = "SQLConnect",
    [string]$AppPool  = "SQLConnect",
    [string]$AppDir   = "D:\KS\SQL",
    [string]$HostName = "",      # e.g. sql.yourcompany.local; blank = catch-all on the port
    [int]   $Port     = 80
)

$ErrorActionPreference = "Stop"
Import-Module WebAdministration

if (-not (Test-Path (Join-Path $AppDir "server.js"))) {
    throw "server.js not found in $AppDir"
}
if (-not (Test-Path (Join-Path $AppDir "web.config"))) {
    throw "web.config not found in $AppDir"
}

# --- App pool: No Managed Code (this site runs Node, not .NET) ----------------
if (Test-Path "IIS:\AppPools\$AppPool") {
    Write-Host "App pool '$AppPool' already exists."
} else {
    New-WebAppPool -Name $AppPool | Out-Null
    Write-Host "Created app pool '$AppPool'."
}
Set-ItemProperty "IIS:\AppPools\$AppPool" managedRuntimeVersion ""           # No Managed Code
Set-ItemProperty "IIS:\AppPools\$AppPool" managedPipelineMode  "Integrated"
Set-ItemProperty "IIS:\AppPools\$AppPool" startMode            "AlwaysRunning"
# Keep the Node process alive (don't idle-timeout / recycle on a schedule).
Set-ItemProperty "IIS:\AppPools\$AppPool" processModel.idleTimeout "00:00:00"
Set-ItemProperty "IIS:\AppPools\$AppPool" recycling.periodicRestart.time "00:00:00"

# --- Website -----------------------------------------------------------------
if (Test-Path "IIS:\Sites\$SiteName") {
    Write-Host "Site '$SiteName' already exists; updating bindings/path."
    Set-ItemProperty "IIS:\Sites\$SiteName" physicalPath $AppDir
    Set-ItemProperty "IIS:\Sites\$SiteName" applicationPool $AppPool
} else {
    New-Website -Name $SiteName -PhysicalPath $AppDir -ApplicationPool $AppPool `
        -Port $Port -HostHeader $HostName | Out-Null
    Write-Host "Created site '$SiteName' on port $Port (host '$HostName')."
}

# --- Permissions for the app-pool identity -----------------------------------
# iisnode needs: read+execute on the app, and WRITE on logs\ and iisnode\.
$acct = "IIS AppPool\$AppPool"
Write-Host "Granting '$acct' permissions on $AppDir ..."

icacls $AppDir /grant "${acct}:(OI)(CI)(RX)" /T | Out-Null

foreach ($sub in @("logs", "iisnode")) {
    $p = Join-Path $AppDir $sub
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    icacls $p /grant "${acct}:(OI)(CI)(M)" /T | Out-Null
}
# IIS_IUSRS read on the folder (covers static reads / web.config).
icacls $AppDir /grant "IIS_IUSRS:(OI)(CI)(RX)" /T | Out-Null

# --- Start -------------------------------------------------------------------
Restart-WebAppPool -Name $AppPool
Start-Website -Name $SiteName -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done."
if ($HostName) {
    Write-Host "Browse to: http://$HostName" + $(if ($Port -ne 80) { ":$Port" } else { "" })
    Write-Host "(Add a hosts entry or DNS record for '$HostName' if needed.)"
} else {
    Write-Host "Browse to: http://localhost:$Port"
}
Write-Host "iisnode logs: $AppDir\iisnode    App audit logs: $AppDir\logs"
