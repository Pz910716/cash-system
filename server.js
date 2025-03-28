const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

// 載入環境變數
dotenv.config();
const { DB_USER, DB_HOST, DB_DATABASE, DB_PASSWORD, DB_PORT, JWT_SECRET, PORT } = process.env;
if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET in .env");
  process.exit(1);
}
const portValue = PORT || 3000;

const app = express();
app.use(express.json());
app.use(cors());
// 設定靜態檔案路徑（public 資料夾中放 index.html、images/qrcode.jpg、style.css 等）
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// PostgreSQL 連線池
const pool = new Pool({
  user: DB_USER,
  host: DB_HOST,
  database: DB_DATABASE,
  password: DB_PASSWORD,
  port: DB_PORT || 5432,
});

// 建立 users 資料表
const createUsersTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      balance DECIMAL(10,2) DEFAULT 0,
      payment_status VARCHAR(10) DEFAULT '未收款'
    );
  `);
  console.log("users table is ready.");
};

// 確保 users 表有 delivery_date 欄位
const ensureDeliveryDateColumn = async () => {
  try {
    const result = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='users' and column_name='delivery_date'
    `);
    if (result.rowCount === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN delivery_date DATE`);
      console.log("delivery_date column added to users table.");
    } else {
      console.log("delivery_date column already exists.");
    }
  } catch (err) {
    console.error("Error ensuring delivery_date column:", err);
    process.exit(1);
  }
};

// 建立 operators 資料表
const createOperatorsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS operators (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'operator'))
    );
  `);
  console.log("operators table is ready.");
};

// 建立 transactions 資料表
const createTransactionsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      type VARCHAR(10) CHECK (type IN ('deposit', 'withdraw')) NOT NULL,
      details TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log("transactions table is ready.");
};

// 確保 transactions 表有 after_balance 欄位
const ensureAfterBalanceColumn = async () => {
  try {
    const result = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name='transactions' AND column_name='after_balance'
    `);
    if (result.rowCount === 0) {
      await pool.query(`ALTER TABLE transactions ADD COLUMN after_balance DECIMAL(10,2)`);
      console.log("after_balance column added to transactions table.");
    } else {
      console.log("after_balance column already exists in transactions.");
    }
  } catch (err) {
    console.error("Error ensuring after_balance column:", err);
    process.exit(1);
  }
};

// 建立所有資料表
const createTables = async () => {
  try {
    await createUsersTable();
    await ensureDeliveryDateColumn();
    await createOperatorsTable();
    await createTransactionsTable();
    await ensureAfterBalanceColumn();
  } catch (err) {
    console.error("Error creating tables:", err);
    process.exit(1);
  }
};

// 身份驗證中介層（操作員部分）
const authenticate = (req, res, next) => {
  const authHeader = req.header('Authorization');
  if (!authHeader)
    return res.status(401).json({ error: '存取被拒絕' });
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : authHeader;
  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).json({ error: '無效的 token' });
  }
};

// 記錄交易（包含 after_balance）
const addTransaction = async (userId, amount, type, details = null, afterBalance = null) => {
  await pool.query(
    `INSERT INTO transactions (user_id, amount, type, details, after_balance)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, amount, type, details, afterBalance]
  );
};

// 取得客戶資料（包含 delivery_date）
app.get('/users', async (req, res) => {
  try {
    const { search } = req.query;
    let query = 'SELECT user_id AS id, username, balance, payment_status, delivery_date FROM users';
    let params = [];
    if (search) {
      query += ' WHERE username ILIKE $1';
      params.push(`%${search}%`);
    }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /users error:", err);
    res.status(500).json({ error: '伺服器錯誤', message: err.message });
  }
});

// 新增客戶，同時記錄初始儲值交易（若有金額）
app.post('/users', async (req, res) => {
  const { username, balance, payment_status, plan } = req.body;
  if (!username) return res.status(400).json({ error: '客戶名稱必填' });
  try {
    const result = await pool.query(
      'INSERT INTO users (username, balance, payment_status) VALUES ($1, $2, $3) RETURNING user_id, username, balance, payment_status, delivery_date',
      [username, balance ? balance : 0, payment_status ? payment_status : '未收款']
    );
    const newUser = result.rows[0];
    if (parseFloat(newUser.balance) > 0) {
      await addTransaction(newUser.user_id, newUser.balance, 'deposit', `方案: ${plan}`, newUser.balance);
    }
    res.status(201).json(newUser);
  } catch (err) {
    console.error("新增客戶錯誤:", err);
    res.status(500).json({ error: '伺服器錯誤', message: err.message });
  }
});

// 更新配送日期
app.put('/users/:id/delivery-date', async (req, res) => {
  const { id } = req.params;
  const { delivery_date } = req.body;
  if (!delivery_date) return res.status(400).json({ error: '缺少配送日期資訊' });
  try {
    const result = await pool.query(
      'UPDATE users SET delivery_date = $1 WHERE user_id = $2 RETURNING user_id, username, delivery_date',
      [delivery_date, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '找不到客戶' });
    res.json({ message: '配送日期更新成功', user: result.rows[0] });
  } catch (err) {
    console.error("更新配送日期錯誤:", err);
    res.status(500).json({ error: '伺服器錯誤', message: err.message });
  }
});

// 更新付款狀態
app.put('/users/:id/payment-status', async (req, res) => {
  const { id } = req.params;
  const { payment_status } = req.body;
  if (!payment_status) return res.status(400).json({ error: '缺少付款狀態資訊' });
  try {
    const result = await pool.query(
      'UPDATE users SET payment_status = $1 WHERE user_id = $2 RETURNING user_id, username, balance, payment_status',
      [payment_status, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '找不到客戶' });
    res.json({ message: '付款狀態更新成功', user: result.rows[0] });
  } catch (err) {
    console.error("更新付款狀態錯誤:", err);
    res.status(500).json({ error: '伺服器錯誤', message: err.message });
  }
});

// 刪除客戶
app.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM users WHERE user_id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '找不到客戶' });
    res.json({ message: '客戶刪除成功' });
  } catch (err) {
    console.error("刪除客戶錯誤:", err);
    res.status(500).json({ error: '伺服器錯誤', message: err.message });
  }
});

// 儲值操作：更新餘額後記錄 after_balance
app.post('/users/:id/deposit', async (req, res) => {
  const { id } = req.params;
  const { amount, details } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: '金額錯誤' });
  try {
    const userCheck = await pool.query('SELECT * FROM users WHERE user_id = $1', [id]);
    if (userCheck.rows.length === 0) return res.status(404).json({ error: '找不到客戶' });
    const updatedUser = await pool.query(
      'UPDATE users SET balance = balance + $1 WHERE user_id = $2 RETURNING balance',
      [amount, id]
    );
    const newBalance = parseFloat(updatedUser.rows[0].balance);
    await addTransaction(id, amount, 'deposit', details, newBalance);
    res.json({ message: '儲值成功' });
  } catch (err) {
    console.error("儲值錯誤:", err);
    res.status(500).json({ error: '伺服器錯誤', message: err.message });
  }
});

// 扣款操作：更新餘額後記錄 after_balance
app.post('/users/:id/withdraw', async (req, res) => {
  const { id } = req.params;
  const { amount, details } = req.body;
  if (amount == null || amount < 0) return res.status(400).json({ error: '金額錯誤' });
  try {
    const userResult = await pool.query('SELECT balance FROM users WHERE user_id = $1', [id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: '找不到客戶' });
    const currentBalance = parseFloat(userResult.rows[0].balance);
    if (currentBalance < amount) return res.status(400).json({ error: '餘額不足' });
    const updatedUser = await pool.query(
      'UPDATE users SET balance = balance - $1 WHERE user_id = $2 RETURNING balance',
      [amount, id]
    );
    const newBalance = parseFloat(updatedUser.rows[0].balance);
    await addTransaction(id, amount, 'withdraw', details, newBalance);
    res.json({ message: '扣款成功' });
  } catch (err) {
    console.error("扣款錯誤:", err);
    res.status(500).json({ error: '伺服器錯誤', message: err.message });
  }
});

// 查詢客戶交易紀錄 (最新10筆)
app.get('/users/:id/transactions', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("查詢交易紀錄錯誤:", err);
    res.status(500).json({ error: '伺服器錯誤', message: err.message });
  }
});

// 操作員註冊
app.post('/auth/register', async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !['admin', 'operator'].includes(role))
    return res.status(400).json({ error: '資料不完整' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO operators (username, password, role) VALUES ($1, $2, $3)',
      [username, hashedPassword, role]
    );
    res.status(201).json({ message: '操作員註冊成功' });
  } catch (err) {
    console.error("註冊錯誤:", err);
    res.status(500).json({ error: '伺服器錯誤', message: err.message });
  }
});

// 操作員登入
app.post('/auth/login', async (req, res) => {
  try {
    if (!req.body)
      return res.status(400).json({ error: "JSON 格式錯誤" });
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: '缺少使用者名稱或密碼' });
    const result = await pool.query('SELECT * FROM operators WHERE username = $1', [username]);
    if (result.rows.length === 0)
      return res.status(400).json({ error: '找不到該操作員' });
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword)
      return res.status(400).json({ error: '帳號或密碼錯誤' });
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (err) {
    console.error("登入錯誤:", err);
    res.status(500).json({ error: '伺服器錯誤', message: err.message });
  }
});

// 啟動伺服器：先建立所有資料表
createTables()
  .then(() => {
    app.listen(portValue, '0.0.0.0', () => {
      console.log(`Server running on 0.0.0.0:${portValue}`);
    });
  })
  .catch((err) => {
    console.error("建立資料表失敗:", err);
    process.exit(1);
  });
