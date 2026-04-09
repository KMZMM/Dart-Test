Param(
  [string]$Region = $(if ($env:DO_REGION) { $env:DO_REGION } else { "sgp1" }),
  [string]$AppName = $(if ($env:DO_APP_NAME) { $env:DO_APP_NAME } else { "techstore-bot" }),
  [string]$GithubRepo = $env:DO_GITHUB_REPO,
  [string]$GithubBranch = $(if ($env:DO_GITHUB_BRANCH) { $env:DO_GITHUB_BRANCH } else { "main" }),
  [bool]$DeployOnPush = $true,
  [bool]$UseGeneratedDatabaseUrl = $true
)

$ErrorActionPreference = "Stop"

function Import-EnvFile {
  param([string]$EnvFilePath)

  if (-not (Test-Path $EnvFilePath)) {
    return
  }

  Get-Content $EnvFilePath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      return
    }
    $parts = $line.Split("=", 2)
    if ($parts.Count -ne 2) {
      return
    }
    $key = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"')
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
  }
}

$rootEnv = Join-Path $PSScriptRoot "..\.env"
Import-EnvFile -EnvFilePath $rootEnv

if ([string]::IsNullOrWhiteSpace($env:DIGITALOCEAN_TOKEN)) {
  throw "DIGITALOCEAN_TOKEN is required."
}
if ([string]::IsNullOrWhiteSpace($GithubRepo)) {
  throw "DO_GITHUB_REPO is required. Example: owner/repo"
}
if ([string]::IsNullOrWhiteSpace($env:TELEGRAM_BOT_TOKEN)) {
  throw "TELEGRAM_BOT_TOKEN is required."
}

$generatedEnvFile = Join-Path $PSScriptRoot "..\do.generated.env"
if ($UseGeneratedDatabaseUrl -and (Test-Path $generatedEnvFile)) {
  Get-Content $generatedEnvFile | ForEach-Object {
    if ($_ -match "=") {
      $parts = $_.Split("=", 2)
      if ($parts.Count -eq 2) {
        [System.Environment]::SetEnvironmentVariable($parts[0], $parts[1], "Process")
      }
    }
  }
}

if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL)) {
  throw "DATABASE_URL is required. Run npm run provision:do first or set DATABASE_URL manually."
}

$headers = @{
  Authorization = "Bearer $($env:DIGITALOCEAN_TOKEN)"
  "Content-Type" = "application/json"
}

function Invoke-DoRequest {
  param(
    [string]$Method,
    [string]$Path,
    [object]$Body = $null
  )

  $uri = "https://api.digitalocean.com/v2$Path"
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Depth 20
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body $json
  }
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers
}

$envs = @(
  @{
    key = "TELEGRAM_BOT_TOKEN"
    scope = "RUN_TIME"
    type = "SECRET"
    value = $env:TELEGRAM_BOT_TOKEN
  },
  @{
    key = "DATABASE_URL"
    scope = "RUN_TIME"
    type = "SECRET"
    value = $env:DATABASE_URL
  },
  @{
    key = "ADMIN_TELEGRAM_IDS"
    scope = "RUN_TIME"
    type = "SECRET"
    value = $env:ADMIN_TELEGRAM_IDS
  },
  @{
    key = "JOIN_CHANNEL_LINK"
    scope = "RUN_TIME"
    type = "GENERAL"
    value = $(if ($env:JOIN_CHANNEL_LINK) { $env:JOIN_CHANNEL_LINK } else { "https://t.me/KMZCreationsMM" })
  },
  @{
    key = "PAYMENT_PHONE"
    scope = "RUN_TIME"
    type = "GENERAL"
    value = $(if ($env:PAYMENT_PHONE) { $env:PAYMENT_PHONE } else { "09986075167" })
  },
  @{
    key = "PAYMENT_ACCOUNT_NAME"
    scope = "RUN_TIME"
    type = "GENERAL"
    value = $(if ($env:PAYMENT_ACCOUNT_NAME) { $env:PAYMENT_ACCOUNT_NAME } else { "Ye Htut Naing" })
  }
)

$spec = @{
  name   = $AppName
  region = $Region
  workers = @(
    @{
      name               = "bot-worker"
      environment_slug   = "node-js"
      github             = @{
        repo = $GithubRepo
        branch = $GithubBranch
        deploy_on_push = [bool]$DeployOnPush
      }
      source_dir         = "/"
      instance_count     = 1
      instance_size_slug = "apps-s-1vcpu-0.5gb"
      build_command      = "npm ci && npx prisma generate && npm run build"
      run_command        = "npx prisma migrate deploy && npm run seed && npm run start"
      envs               = $envs
    }
  )
}

Write-Host "Checking existing apps..."
$apps = Invoke-DoRequest -Method "GET" -Path "/apps"
$existing = $apps.apps | Where-Object { $_.spec.name -eq $AppName } | Select-Object -First 1

if ($existing) {
  Write-Host "Updating existing app: $($existing.id)"
  $result = Invoke-DoRequest -Method "PUT" -Path "/apps/$($existing.id)" -Body @{ spec = $spec }
  $app = $result.app
} else {
  Write-Host "Creating app: $AppName"
  $result = Invoke-DoRequest -Method "POST" -Path "/apps" -Body @{ spec = $spec }
  $app = $result.app
}

Write-Host ""
Write-Host "App deployed."
Write-Host "App ID: $($app.id)"
if ($app.live_url) {
  Write-Host "Live URL: $($app.live_url)"
}
