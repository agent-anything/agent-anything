[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $PnpmArguments
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$nodeVersion = (Get-Content -LiteralPath (Join-Path $repositoryRoot ".node-version") -Raw).Trim().TrimStart("v")
$package = Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw | ConvertFrom-Json
$pnpmVersion = ([string] $package.packageManager).Split("@")[-1]
$fnm = Get-Command fnm -CommandType Application -ErrorAction Stop

Push-Location $repositoryRoot
try {
  & $fnm.Source env --use-on-cd --shell powershell |
    Out-String |
    Invoke-Expression
  & $fnm.Source use $nodeVersion --silent-if-unchanged | Out-Null

  $actualNodeVersion = (& node --version).Trim().TrimStart("v")
  $actualPnpmVersion = (& pnpm --version).Trim()
  if ($actualNodeVersion -ne $nodeVersion) {
    throw "Repository requires Node $nodeVersion from fnm; resolved $actualNodeVersion."
  }
  if ($actualPnpmVersion -ne $pnpmVersion) {
    throw "Repository requires pnpm $pnpmVersion; resolved $actualPnpmVersion."
  }

  & pnpm @PnpmArguments
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
