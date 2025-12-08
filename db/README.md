使用说明

- 将你的 `backup.sql` 放到本目录下，文件名建议为 `backup.sql`。
- 脚本位于项目根 `scripts/restore-db.ps1`，可用于将 SQL 导入本地 MySQL。

示例：把 `backup.sql` 放到 `db/` 后，在项目根运行：

```powershell
.\scripts\restore-db.ps1
```

如果 MySQL 未在 PATH 中，请使用：

```powershell
.\scripts\restore-db.ps1 -MysqlPath 'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysql.exe'
```
