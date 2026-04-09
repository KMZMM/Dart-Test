Param(
  [string]$Region = $(if ($env:DO_REGION) { $env:DO_REGION } else { "sgp1" }),
  [string]$ClusterName = $(if ($env:DO_DB_CLUSTER_NAME) { $env:DO_DB_CLUSTER_NAME } else { "techstore-db" }),
  [string]$DbName = $(if ($env:DO_DB_NAME) { $env:DO_DB_NAME } else { "techstore" }),
  [string]$DbVersion = "16",
  [string]$DbSize = "db-s-1vcpu-1gb"
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

Write-Host "Checking existing database clusters..."
$dbList = Invoke-DoRequest -Method "GET" -Path "/databases"
$cluster = $dbList.databases | Where-Object { $_.name -eq $ClusterName } | Select-Object -First 1

if (-not $cluster) {
  Write-Host "Creating managed PostgreSQL cluster: $ClusterName ($Region)"
  $createBody = @{
    name       = $ClusterName
    engine     = "pg"
    version    = $DbVersion
    region     = $Region
    size       = $DbSize
    num_nodes  = 1
  }

  $createRes = Invoke-DoRequest -Method "POST" -Path "/databases" -Body $createBody
  $cluster = $createRes.database
} else {
  Write-Host "Using existing cluster: $($cluster.id)"
}

$maxAttempts = 60
$attempt = 0
do {
  $attempt += 1
  $clusterInfo = Invoke-DoRequest -Method "GET" -Path "/databases/$($cluster.id)"
  $status = $clusterInfo.database.status
  Write-Host "Cluster status: $status"
  if ($status -eq "online") {
    break
  }
  Start-Sleep -Seconds 10
} while ($attempt -lt $maxAttempts)

if ($status -ne "online") {
  throw "Cluster did not become online in time."
}

Write-Host "Ensuring database '$DbName' exists..."
$dbs = Invoke-DoRequest -Method "GET" -Path "/databases/$($cluster.id)/dbs"
$exists = $dbs.dbs | Where-Object { $_.name -eq $DbName } | Select-Object -First 1
if (-not $exists) {
  Invoke-DoRequest -Method "POST" -Path "/databases/$($cluster.id)/dbs" -Body @{ name = $DbName } | Out-Null
  Write-Host "Created database $DbName."
} else {
  Write-Host "Database $DbName already exists."
}

$clusterInfo = Invoke-DoRequest -Method "GET" -Path "/databases/$($cluster.id)"
$conn = $clusterInfo.database.connection
if (-not $conn) {
  throw "Failed to read database connection details."
}

$encodedUser = [System.Uri]::EscapeDataString($conn.user)
$encodedPass = [System.Uri]::EscapeDataString($conn.password)
$databaseUrl = "postgresql://$encodedUser`:$encodedPass@$($conn.host):$($conn.port)/$DbName?sslmode=require&schema=public"

$outputPath = Join-Path $PSScriptRoot "..\do.generated.env"
$content = @(
  "DO_DB_CLUSTER_ID=$($cluster.id)"
  "DO_DB_HOST=$($conn.host)"
  "DO_DB_PORT=$($conn.port)"
  "DO_DB_USER=$($conn.user)"
  "DO_DB_NAME=$DbName"
  "DATABASE_URL=$databaseUrl"
)

$content | Set-Content -Path $outputPath -Encoding UTF8

Write-Host ""
Write-Host "Provisioning completed."
Write-Host "Cluster ID: $($cluster.id)"
Write-Host "Database URL saved to: $outputPath"
