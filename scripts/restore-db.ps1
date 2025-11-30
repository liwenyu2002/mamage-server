Param(
    [string]$SqlFile = ".\db\backup.sql",
    [string]$DbName = "mamage",
    [string]$MysqlPath = $null
)

function Find-MySQL {
    if ($PSBoundParameters.ContainsKey('MysqlPath') -and $MysqlPath) { return $MysqlPath }
    $cmd = Get-Command mysql -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Path }
    $candidates = Get-ChildItem 'C:\Program Files\MySQL' -Recurse -Filter mysql.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
    if ($candidates) { return $candidates }
    return $null
}

$mysql = Find-MySQL
if (-not $mysql) {
    Write-Error "找不到 mysql 可执行文件。请将 MySQL 安装目录的 `bin` 添加到 PATH，或使用 -MysqlPath 指定路径。示例: -MysqlPath 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe'"
    exit 1
}

if (-not (Test-Path $SqlFile)) {
    Write-Error "找不到 SQL 文件： $SqlFile"
    exit 1
}

Write-Output "使用 mysql: $mysql"
# 使用 cmd.exe 来支持输入重定向 '<'
$mysqlEsc = $mysql.Replace('"','\"')
$sqlFull = (Resolve-Path $SqlFile).Path
$cmd = "cmd /c \"$mysqlEsc\" -u root -p -e \"CREATE DATABASE IF NOT EXISTS $DbName DEFAULT CHARACTER SET utf8mb4;\" && \"$mysqlEsc\" -u root -p $DbName < \"$sqlFull\""
Write-Output "将执行： $cmd"
Invoke-Expression $cmd
