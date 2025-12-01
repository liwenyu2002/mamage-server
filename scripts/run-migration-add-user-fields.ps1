<#
Run this script to apply the users table migration.
It will:
  1) Create a dump of the `users` table to `db/users-backup.sql` (safe backup).
  2) Execute the migration SQL `scripts/migrations/20251201_add_user_fields.sql` against your database.

Usage (from project root):
  .\scripts\run-migration-add-user-fields.ps1 -MysqlExe "C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe" -DbName "MaMage" -DbUser "root"

If you omit -MysqlExe the script will try to find `mysql.exe` on PATH.
#>
param(
  [string]$MysqlExe = 'mysql',
  [string]$MysqldumpExe = 'mysqldump',
  [string]$DbName = 'MaMage',
  [string]$DbUser = 'root'
)

$scriptPath = Join-Path $PSScriptRoot 'migrations\20251201_add_user_fields.sql'
$backupDir = Join-Path $PSScriptRoot '..\db'
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }
$backupFile = Join-Path $backupDir 'users-backup.sql'

Write-Host "Using mysql: $MysqlExe`nUsing mysqldump: $MysqldumpExe`nDB: $DbName`nUser: $DbUser"

# Create a dump of users table
$dumpCmd = "`"$MysqldumpExe`" -u $DbUser $DbName users > `"$backupFile`""
Write-Host "Creating backup: $backupFile"
try {
  iex $dumpCmd
  Write-Host "Backup completed."
} catch {
  Write-Warning "Backup failed. Please ensure mysqldump is available and credentials are correct. Error: $_"
  exit 1
}

# Apply migration
$applyCmd = "`"$MysqlExe`" -u $DbUser $DbName < `"$scriptPath`""
Write-Host "Applying migration: $scriptPath"
try {
  iex $applyCmd
  Write-Host "Migration applied successfully."
} catch {
  Write-Error "Migration failed. See error above."
  exit 2
}

Write-Host "Done. Verify schema and restart the server if needed."
