// db.js
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: '127.0.0.1',        // 就是你刚刚用来测试的那个
  port: 3306,               // 如果你 SHOW VARIABLES 看到不是 3306，就改成实际端口
  user: 'root',
  password: '320911',
  database: 'MaMage',       // 你现在用的库名
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = { pool };
