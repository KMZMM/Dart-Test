Param(
  [string]$Region = $(if ($env:DO_REGION) { $env:DO_REGION } else { "sgp1" }),
  [string]$AppName = $(if ($env:DO_APP_NAME) { $env:DO_APP_NAME } else { "techstore-bot" }),
  [string]$GithubRepo = $env:DO_GITHUB_REPO,
  [string]$GithubBranch = $(if ($env:DO_GITHUB_BRANCH) { $env:DO_GITHUB_BRANCH } else { "main" }),
  [bool]$DeployOnPush = $true,
  [bool]$UseGeneratedDatabaseUrl = $true,
  [bool]$UseAppManagedDatabase = $true
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

if (-not $UseAppManagedDatabase -and [string]::IsNullOrWhiteSpace($env:DATABASE_URL)) {
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

$databaseEnv = if ($UseAppManagedDatabase) {
  @{
    key = "DATABASE_URL"
    scope = "RUN_TIME"
    type = "GENERAL"
    value = '${db.DATABASE_URL}'
  }
} else {
  @{
    key = "DATABASE_URL"
    scope = "RUN_TIME"
    type = "SECRET"
    value = $env:DATABASE_URL
  }
}

$envs = @(
  @{
    key = "TELEGRAM_BOT_TOKEN"
    scope = "RUN_TIME"
    type = "SECRET"
    value = $env:TELEGRAM_BOT_TOKEN
  },
  $databaseEnv,
  @{
    key = "ADMIN_TELEGRAM_IDS"
    scope = "RUN_TIME"
    type = "SECRET"
    value = $env:ADMIN_TELEGRAM_IDS
  },
  @{
    key = "ADMIN_USERNAMES"
    scope = "RUN_TIME"
    type = "GENERAL"
    value = $(if ($env:ADMIN_USERNAMES) { $env:ADMIN_USERNAMES } else { "y_e_h_t_u_t" })
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
  },
  @{
    key = "GUIDE_TOPUP_VIDEO_URL"
    scope = "RUN_TIME"
    type = "GENERAL"
    value = $(if ($env:GUIDE_TOPUP_VIDEO_URL) { $env:GUIDE_TOPUP_VIDEO_URL } else { "" })
  },
  @{
    key = "GUIDE_BUY_VIDEO_URL"
    scope = "RUN_TIME"
    type = "GENERAL"
    value = $(if ($env:GUIDE_BUY_VIDEO_URL) { $env:GUIDE_BUY_VIDEO_URL } else { "" })
  },
  @{
    key = "ADMIN_PANEL_USERNAME"
    scope = "RUN_TIME"
    type = "GENERAL"
    value = $(if ($env:ADMIN_PANEL_USERNAME) { $env:ADMIN_PANEL_USERNAME } else { "YeHtut" })
  },
  @{
    key = "ADMIN_PANEL_PASSWORD"
    scope = "RUN_TIME"
    type = "SECRET"
    value = $(if ($env:ADMIN_PANEL_PASSWORD) { $env:ADMIN_PANEL_PASSWORD } else { "KMZgaming" })
  },
  @{
    key = "ADMIN_SESSION_SECRET"
    scope = "RUN_TIME"
    type = "SECRET"
    value = $(if ($env:ADMIN_SESSION_SECRET) { $env:ADMIN_SESSION_SECRET } else { "techstore-admin-session" })
  },
  @{
    key = "OUTLINE_API_URL"
    scope = "RUN_TIME"
    type = "SECRET"
    value = $(if ($env:OUTLINE_API_URL) { $env:OUTLINE_API_URL } else { "https://159.223.55.193:64519/g0VqaB01yZcs90cUB1jcTg" })
  },
  @{
    key = "OUTLINE_INSECURE_TLS"
    scope = "RUN_TIME"
    type = "GENERAL"
    value = $(if ($env:OUTLINE_INSECURE_TLS) { $env:OUTLINE_INSECURE_TLS } else { "true" })
  },
  @{
    key = "USER_WEB_BASE_URL"
    scope = "RUN_TIME"
    type = "GENERAL"
    value = $(if ($env:USER_WEB_BASE_URL) { $env:USER_WEB_BASE_URL } else { "" })
  },
  @{
    key = "USER_VIEW_LINK_SECRET"
    scope = "RUN_TIME"
    type = "SECRET"
    value = $(if ($env:USER_VIEW_LINK_SECRET) { $env:USER_VIEW_LINK_SECRET } else { "" })
  }
)

$spec = @{
  name   = $AppName
  region = $Region
  services = @(
    @{
      name               = "admin-web"
      environment_slug   = "node-js"
      github             = @{
        repo = $GithubRepo
        branch = $GithubBranch
        deploy_on_push = [bool]$DeployOnPush
      }
      source_dir         = "/"
      http_port          = 8080
      instance_count     = 1
      instance_size_slug = "apps-s-1vcpu-0.5gb"
      routes             = @(
        @{
          path = "/"
        }
      )
      build_command      = "npm ci && npx prisma generate && npm run build"
      run_command        = "npx prisma db push && npm run start:web"
      envs               = $envs
    }
  )
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
      run_command        = "npx prisma db push && node dist/scripts/seed.js && npm run start"
      envs               = $envs
    }
  )
}

if ($UseAppManagedDatabase) {
  $spec["databases"] = @(
    @{
      engine = "PG"
      name = "db"
      version = "16"
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
