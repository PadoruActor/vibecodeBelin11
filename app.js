const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = 3000;

// Инициализация бота (используйте свой токен)
const bot = new TelegramBot('7315068710:AAHdBCj4t16yneNzlMhZGbPsmJlHIsYrZFw', {
    polling: true
});

// Конфигурация БД (проверьте параметры)
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: 'admin', // ваш пароль MySQL
    database: 'todolist',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// Создаем pool соединений вместо одиночного соединения
const pool = mysql.createPool(dbConfig);

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Храним связь Telegram-аккаунтов с пользователями
const telegramUsers = new Map();

// Инициализация БД
async function initDB() {
    let conn;
    try {
        conn = await pool.getConnection();

        // Создаем таблицу пользователей
        await conn.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                telegram_id VARCHAR(50) NULL
            )
        `);

        // Создаем таблицу задач с привязкой к пользователю
        await conn.query(`
            CREATE TABLE IF NOT EXISTS items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                text VARCHAR(255) NOT NULL,
                user_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);



        console.log('Database initialized successfully');
    } catch (err) {
        console.error('Database initialization error:', err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}
initDB();
// Проверяем соединение с БД
async function checkDatabaseConnection() {
    try {
        const conn = await pool.getConnection();
        await conn.ping();
        conn.release();
        console.log('Successfully connected to the database');
        return true;
    } catch (err) {
        console.error('Database connection error:', err);
        return false;
    }
}

// Инициализируем приложение
async function startApp() {
    if (await checkDatabaseConnection()) {
        await initDB();
        startServer();
    } else {
        console.error('Failed to connect to database. Please check your credentials and make sure MySQL is running.');
        process.exit(1);
    }
}

// Telegram Bot Handlers

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Добро пожаловать! Используйте:\n' +
        '/register <username> <password> - регистрация\n' +
        '/login <username> <password> - вход\n' +
        '/add <task> - добавить задачу\n' +
        '/list - список задач\n' +
        '/delete <id> - удалить задачу');
});

bot.onText(/\/register (.+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const username = match[1];
    const password = match[2];
    let conn; // Объявляем переменную ЗДЕСЬ, перед try

    if (!username || !password) {
        return bot.sendMessage(chatId, 'Использование: /register <username> <password>');
    }

    try {
        conn = await pool.getConnection(); // Присваиваем значение
        const hashedPassword = await bcrypt.hash(password, 10);

        await conn.query(
            'INSERT INTO users (username, password, telegram_id) VALUES (?, ?, ?)',
            [username, hashedPassword, chatId.toString()]
        );

        const [users] = await conn.query('SELECT id FROM users WHERE username = ?', [username]);
        telegramUsers.set(chatId, users[0].id);
        bot.sendMessage(chatId, 'Регистрация успешна! Теперь используйте /add для добавления задач');
    } catch (err) {
        console.error('Registration error:', err);
        let errorMessage = 'Ошибка сервера';

        if (err.code === 'ER_DUP_ENTRY') {
            errorMessage = 'Имя пользователя занято';
        }

        bot.sendMessage(chatId, 'Ошибка: ' + errorMessage);
    } finally {
        if (conn) conn.release(); // Теперь conn доступна
    }
});

bot.onText(/\/login (.+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const username = match[1];
    const password = match[2];

    try {
        const conn = await pool.getConnection();
        const [users] = await conn.query('SELECT * FROM users WHERE username = ?', [username]);

        if (users.length === 0 || !(await bcrypt.compare(password, users[0].password))) {
            return bot.sendMessage(chatId, 'Неверное имя пользователя или пароль');
        }

        telegramUsers.set(chatId, users[0].id);
        bot.sendMessage(chatId, 'Вход выполнен! Используйте /add для добавления задач');
    } catch (err) {
        bot.sendMessage(chatId, 'Ошибка входа');
    }
});

bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = telegramUsers.get(chatId);

    if (!userId) {
        return bot.sendMessage(chatId, 'Сначала выполните вход (/login)');
    }

    const text = match[1];
    try {
        const conn = await pool.getConnection();
        await conn.query('INSERT INTO items (text, user_id) VALUES (?, ?)', [text, userId]);
        bot.sendMessage(chatId, `Задача добавлена: "${text}"`);
    } catch (err) {
        bot.sendMessage(chatId, 'Ошибка при добавлении задачи');
    }
});

bot.onText(/\/list/, async (msg) => {

    const chatId = msg.chat.id;
    const userId = telegramUsers.get(chatId);

    if (!userId) {
        return bot.sendMessage(chatId, 'Сначала выполните вход (/login)');
    }

    try {
        const conn = await pool.getConnection();
        const [items] = await conn.query('SELECT id, text FROM items WHERE user_id = ?', [userId]);

        if (items.length === 0) {
            return bot.sendMessage(chatId, 'Нет задач');
        }

        const tasks = items.map(item => `${item.id}. ${item.text}`).join('\n');
        bot.sendMessage(chatId, `Ваши задачи:\n${tasks}\n\nДля удаления используйте /delete <id>`);
    } catch (err) {
        bot.sendMessage(chatId, 'Ошибка при получении задач');
    }
});

bot.onText(/\/delete (\d+)/, async (msg, match) => {
    console.log('Received /login command', msg, match);
    const chatId = msg.chat.id;
    const userId = telegramUsers.get(chatId);
    const taskId = match[1];

    if (!userId) {
        return bot.sendMessage(chatId, 'Сначала выполните вход (/login)');
    }

    try {
        const conn = await pool.getConnection();
        const [result] = await conn.query('DELETE FROM items WHERE id = ? AND user_id = ?', [taskId, userId]);

        if (result.affectedRows === 0) {
            return bot.sendMessage(chatId, 'Задача не найдена или нет прав для удаления');
        }

        bot.sendMessage(chatId, 'Задача удалена');
    } catch (err) {
        bot.sendMessage(chatId, 'Ошибка при удалении задачи');
    }
});




// Login Routes
app.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).send('Username and password are required');
    }

    try {
        const conn = await mysql.createConnection(dbConfig);
        const [users] = await conn.execute(
            'SELECT * FROM users WHERE username = ?',
            [username]
        );

        if (users.length === 0) {
            return res.status(401).send('Invalid username or password');
        }

        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return res.status(401).send('Invalid username or password');
        }

        req.session.user = { id: user.id, username: user.username };
        res.redirect('/');
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).send('Server error during login');
    }
});

// Registration Routes
app.get('/register', (req, res) => {
    if (req.session.user) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).send('Username and password are required');
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const conn = await mysql.createConnection(dbConfig);

        await conn.execute(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword]
        );

        res.redirect('/login');
    } catch (err) {
        console.error('Registration error:', err);
        let errorMessage = 'Registration failed';
        if (err.code === 'ER_DUP_ENTRY') {
            errorMessage = 'Username already exists';
        }
        res.status(400).send(errorMessage);
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// To-Do List Routes
app.get('/items', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const conn = await mysql.createConnection(dbConfig);
        const [items] = await conn.execute(
            'SELECT id, text FROM items WHERE user_id = ?',
            [req.session.user.id]
        );
        await conn.end();
        res.json(items);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/items', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    try {
        const conn = await mysql.createConnection(dbConfig);
        await conn.execute(
            'INSERT INTO items (text, user_id) VALUES (?, ?)',
            [text, req.session.user.id]
        );
        await conn.end();
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/items/:id/delete', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const conn = await mysql.createConnection(dbConfig);
        await conn.execute(
            'DELETE FROM items WHERE id = ? AND user_id = ?',
            [req.params.id, req.session.user.id]
        );
        await conn.end();
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Protected home page
app.get('/', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});