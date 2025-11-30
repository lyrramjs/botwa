// index.js (FINAL FIX COMPLETE - FULL BUTTON ORDER SYSTEM WITH PAGINATION)
// Node 18+ recommended

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const QRCode = require('qrcode');
const { Telegraf, Markup } = require('telegraf');

// ========================
// CONFIG / GLOBAL
// ========================
const BOT_TOKEN = process.env.BOT_TOKEN || '8156052053:AAH16-yGrqrgzhzd_yUqo0IBO_0cuHHgbmU';
if (!BOT_TOKEN) {
    console.error("ERROR: BOT_TOKEN tidak ditemukan di .env");
    process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);

// Payment / QRIS API (ciaatopup example)
global.pay = {
    apikey: process.env.PAY_APIKEY || 'CiaaTopUp_ylddpmphwjwq4rb2',
    fee: Number(process.env.PAY_FEE) || 300,
    metode: process.env.PAY_METODE || 'QRISFAST',
    expiredMs: Number(process.env.PAY_EXPIRE_MS) || (30 * 60 * 1000)
};

// Pterodactyl / Panel API
global.domain = process.env.PTERO_DOMAIN || 'https://server-king-store.loveme.my.id';
global.apikey = process.env.PTERO_APIKEY || 'ptla_rdscmMTygt8L7pG4uhlbUDVMmxUUyhJnfbXJ3Xtg7s9';
global.egg = Number(process.env.PTERO_EGG) || 15;
global.nestid = Number(process.env.PTERO_NESTID) || 5;
global.loc = Number(process.env.PTERO_LOC) || 1;

global.linkgc = "https://t.me/+AEkxDXQZvw1hZDE9"
// Owners (from env OWNER_IDS = "123456,987654")
const OWNER_IDS = (process.env.OWNER_IDS || '7009109669').split(',').filter(Boolean).map(s => s.trim());

// DB file
const DB_PATH = path.join(__dirname, 'database.json');
let db = {
    users: {},
    orders: {},
    topups: {},
    sessions: {},
    meta: {}
};

// Load DB
try {
    if (fs.existsSync(DB_PATH)) {
        const raw = fs.readFileSync(DB_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        db = { ...db, ...parsed };
        console.log('Database loaded.');
    } else {
        console.log('Database not found, creating new.');
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    }
} catch (e) {
    console.error('Failed to load DB:', e.message || e);
}

// helper to save DB
function saveDb() {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    } catch (e) {
        console.error('Failed to save DB:', e.message || e);
    }
}

// ========================
// UTIL FUNCTIONS
// ========================
function toRupiah(n = 0) {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n);
}

function rand(min = 100, max = 999) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function genOrderId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function isOwner(id) {
    if (!id) return false;
    return OWNER_IDS.includes(String(id));
}

// safe editMessageText
async function safeEdit(ctx, text, extra = {}) {
    try {
        if (ctx.updateType === 'callback_query' && ctx.editMessageText) {
            await ctx.editMessageText(text, extra);
        } else if (ctx.updateType === 'message' && ctx.message && ctx.message.message_id) {
            if (ctx.update.message && ctx.update.message.message_id) {
                await ctx.telegram.editMessageText(ctx.chat.id, ctx.update.message.message_id, undefined, text, extra).catch(async () => {
                    await ctx.reply(text, extra);
                });
            } else {
                await ctx.reply(text, extra);
            }
        } else {
            await ctx.reply(text, extra);
        }
    } catch (e) {
        try {
            await ctx.reply(text, extra);
        } catch (er) {
            console.error('safeEdit fallback failed:', er?.message || er);
        }
    }
}

// notify owners helper
async function notifyOwners(text) {
    for (const id of OWNER_IDS) {
        try {
            await bot.telegram.sendMessage(id, text);
        } catch (e) {
            console.error('Notify owner failed', id, e?.message || e);
        }
    }
}

// ========================
// API FUNCTIONS
// ========================
async function getPriceList() {
    try {
        const response = await axios.get('https://ciaatopup.my.id/h2h/layanan/price-list', {
            headers: { 'X-APIKEY': global.pay.apikey }
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching price list:', error?.response?.data || error?.message || error);
        return null;
    }
}

// Group products by category
function groupProductsByCategory(products) {
    const categories = {};
    products.forEach(product => {
        if (!categories[product.category]) {
            categories[product.category] = [];
        }
        categories[product.category].push(product);
    });
    return categories;
}

// ========================
// SESSION MANAGEMENT (FIXED)
// ========================
// Global temporary storage untuk session order (MEMORY-BASED)
const orderSessions = new Map();

function getSession(chatId) {
    return db.sessions[chatId];
}

function setSession(chatId, sessionData) {
    db.sessions[chatId] = {
        ...sessionData,
        lastUpdated: Date.now()
    };
    saveDb();
}

function clearSession(chatId) {
    delete db.sessions[chatId];
    saveDb();
}

// Clean expired sessions every 10 minutes
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    Object.keys(db.sessions).forEach(chatId => {
        if (now - (db.sessions[chatId].lastUpdated || 0) > 30 * 60 * 1000) {
            delete db.sessions[chatId];
            cleaned++;
        }
    });
    if (cleaned > 0) {
        saveDb();
        console.log(`Cleaned ${cleaned} expired sessions`);
    }
}, 10 * 60 * 1000);

// Cleanup expired order sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [sessionId, session] of orderSessions.entries()) {
        if (now - session.timestamp > 30 * 60 * 1000) {
            orderSessions.delete(sessionId);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`Cleaned ${cleaned} expired order sessions`);
    }
}, 5 * 60 * 1000);

// ========================
// START / MENU
// ========================
bot.start((ctx) => {
    const name = ctx.from?.first_name || 'User';
    ctx.reply(
        `👋 Hai *${name}*!\nSelamat datang di Panel & PPOB Bot.\nPilih layanan:`,
        {
            parse_mode: 'Markdown',
            ...Markup.keyboard([
                ['/order', '/buypanel'],
                ['/saldo', '/topup'],
                ['/cek_topup', isOwner(ctx.from.id) ? '/menu_owner' : '/cek_topup'].filter(Boolean)
            ]).resize()
        }
    );
});

bot.command('menu', (ctx) => {
    ctx.reply('Menu utama:', Markup.keyboard([
        ['/order', '/buypanel'],
        ['/saldo', '/topup'],
        ['/cek_topup', isOwner(ctx.from.id) ? '/menu_owner' : '/cek_topup'].filter(Boolean)
    ]).resize());
});

// ========================
// OWNER MANAGEMENT
// ========================
bot.command('addowner', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('Hanya owner yang dapat menggunakan perintah ini.');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) return ctx.reply('Gunakan: /addowner <telegram_id>');
    const id = args[0].trim();
    if (OWNER_IDS.includes(id)) return ctx.reply('Owner sudah terdaftar.');
    OWNER_IDS.push(id);
    db.meta.owners = db.meta.owners || [];
    db.meta.owners.push(id);
    saveDb();
    ctx.reply(`Owner ditambahkan: ${id}`);
});

bot.command('delowner', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('Hanya owner yang dapat menggunakan perintah ini.');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) return ctx.reply('Gunakan: /delowner <telegram_id>');
    const id = args[0].trim();
    const idx = OWNER_IDS.indexOf(id);
    if (idx === -1) return ctx.reply('Owner tidak ditemukan.');
    OWNER_IDS.splice(idx, 1);
    db.meta.owners = (db.meta.owners || []).filter(x => x !== id);
    saveDb();
    ctx.reply(`Owner dihapus: ${id}`);
});

// owner menu (admin only)
bot.command('menu_owner', (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('Hanya owner yang dapat mengakses menu ini.');
    ctx.reply('Menu Owner:', Markup.inlineKeyboard([
        [Markup.button.callback('List Topups Pending', 'owner_list_pending')],
        [Markup.button.callback('Broadcast', 'owner_broadcast')]
    ]));
});

bot.action('owner_list_pending', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.answerCbQuery('Access denied', { show_alert: true });
    const pendings = Object.entries(db.topups).filter(([k, t]) => t.status === 'pending').slice(-30);
    if (pendings.length === 0) return ctx.reply('Tidak ada topup pending.');
    let msg = 'Pending Topups:\n\n';
    pendings.forEach(([trx, t], i) => {
        msg += `${i+1}. TRX: ${trx}\nUser: ${t.user_id}\nNominal: ${toRupiah(t.nominal)}\nType: ${t.type}\nCreated: ${new Date(t.created_at).toLocaleString()}\n\n`;
    });
    ctx.reply(msg);
});

// simple broadcast (owner)
bot.action('owner_broadcast', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.answerCbQuery('Access denied', { show_alert: true });
    ctx.reply('Kirim pesan broadcast (balas pesan ini dengan teks yang akan dikirim):');
    setSession(ctx.chat.id, { step: 'owner_broadcast', user: ctx.from.id });
});

// ========================
// BUYPANEL FLOW
// ========================
bot.command('buypanel', (ctx) => {
    notifyOwners(`User /buypanel: @${ctx.from.username || ctx.from.id}`);
    const arg = ctx.message.text.split(' ')[1];
    if (!arg) {
        setSession(ctx.chat.id, { step: 'waiting_username', user: ctx.from.id });
        return ctx.reply('Masukkan username untuk panel baru:', Markup.keyboard([['Kembali ke Menu']]).oneTime().resize());
    }
    const username = String(arg).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!username) return ctx.reply('Username tidak valid.');
    const tgId = String(ctx.from.id);
    db.users[tgId] = db.users[tgId] || { saldo: 0 };
    db.users[tgId].temp_username = username;
    saveDb();
    ctx.reply(
        `Pilih RAM untuk username ${username}`,
        Markup.inlineKeyboard([
            [Markup.button.callback('RAM 1GB - 1.000', 'ram_1gb')],
            [Markup.button.callback('RAM 2GB - 2.000', 'ram_2gb')],
            [Markup.button.callback('RAM 3GB - 3.000', 'ram_3gb')],
            [Markup.button.callback('RAM 4GB - 4.000', 'ram_4gb')],
            [Markup.button.callback('RAM Unlimited - 11.000', 'ram_unli')],
            [Markup.button.callback('Kembali', 'back_to_menu')]
        ])
    );
});

// RAM options table
const ramOptions = {
    ram_1gb: { ram: 1000, disk: 1000, cpu: 40, harga: 1000 },
    ram_2gb: { ram: 2000, disk: 2000, cpu: 60, harga: 2000 },
    ram_3gb: { ram: 3000, disk: 3000, cpu: 80, harga: 3000 },
    ram_4gb: { ram: 4000, disk: 4000, cpu: 100, harga: 4000 },
    ram_unli: { ram: 999999, disk: 999999, cpu: 0, harga: 11000 },
};

Object.keys(ramOptions).forEach(key => {
    bot.action(key, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const tgId = String(ctx.from.id);
            db.users[tgId] = db.users[tgId] || { saldo: 0 };
            const user = db.users[tgId];
            const usn = user.temp_username;
            if (!usn) {
                return safeEdit(ctx, "Session expired. Silakan mulai ulang dengan /buypanel", { parse_mode: 'Markdown' });
            }
            const dts = ramOptions[key];
            user.pending = {
                username: usn,
                harga: dts.harga,
                ram: dts.ram,
                disk: dts.disk,
                cpu: dts.cpu
            };
            saveDb();
            const ramText = dts.ram >= 99999 ? "Unlimited" : `${dts.ram}MB`;
            await safeEdit(ctx,
                `RAM: ${ramText}\nHarga: ${toRupiah(dts.harga)}\n\nPilih pembayaran:`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('Bayar Saldo', 'pay_saldo')],
                    [Markup.button.callback('Bayar QRIS', 'pay_qris')],
                    [Markup.button.callback('Kembali', 'back_to_menu')]
                ])
            );
        } catch (error) {
            console.error("Error in ram selection:", error);
            ctx.reply("Terjadi error, silakan coba lagi.");
        }
    });
});

// PAY SALDO
bot.action('pay_saldo', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const tgId = String(ctx.from.id);
        db.users[tgId] = db.users[tgId] || { saldo: 0 };
        const user = db.users[tgId];
        if (!user.pending) return safeEdit(ctx, "Tidak ada transaksi yang sedang berlangsung.");
        if (user.saldo < user.pending.harga) {
            return safeEdit(ctx,
                `Saldo tidak cukup.\nButuh: ${toRupiah(user.pending.harga)}\nSaldo Anda: ${toRupiah(user.saldo)}`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('Topup Saldo', 'topup_saldo')],
                    [Markup.button.callback('Kembali', 'back_to_menu')]
                ])
            );
        }
        user.saldo -= user.pending.harga;
        const orderId = genOrderId();
        db.orders[orderId] = {
            id: orderId,
            user_id: tgId,
            ...user.pending,
            metode: 'saldo',
            status: 'success',
            created_at: Date.now()
        };
        saveDb();
        await safeEdit(ctx, "Pembayaran berhasil.\nMembuat panel...");
        try {
            await createPanelTelegram(ctx, user.pending);
            delete user.pending;
            saveDb();
        } catch (err) {
            console.error('Create panel after saldo failed:', err);
            await ctx.reply('Gagal membuat panel setelah pembayaran. Hubungi admin.');
        }
    } catch (err) {
        console.error('Error in pay_saldo:', err?.message || err);
        ctx.reply('Terjadi error saat proses pembayaran.');
    }
});

// PAY QRIS (create payment)
bot.action('pay_qris', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const tgId = String(ctx.from.id);
        db.users[tgId] = db.users[tgId] || { saldo: 0 };
        const user = db.users[tgId];
        const data = user.pending;
        if (!data) return safeEdit(ctx, 'Tidak ada transaksi yang sedang berlangsung.');
        const amount = Number(data.harga) + rand(100, 250);
        const create = await axios.get(`https://ciaatopup.my.id/h2h/deposit/create?nominal=${amount}&metode=${global.pay.metode}`, {
            headers: { 'X-APIKEY': global.pay.apikey }
        });
        if (!create.data || !create.data.success) {
            console.error('Create pay failed:', create.data);
            return safeEdit(ctx, 'Gagal membuat pembayaran QRIS. Silakan coba lagi.');
        }
        const pay = create.data.data;
        const qrBuffer = await QRCode.toBuffer(pay.qr_string, { width: 300 });
        const orderId = genOrderId();
        db.orders[orderId] = {
            id: orderId,
            user_id: tgId,
            ...data,
            metode: 'qris',
            status: 'pending',
            nominal: amount,
            trx: pay.id,
            created_at: Date.now()
        };
        db.topups[pay.id] = {
            user_id: tgId,
            nominal: amount,
            status: 'pending',
            created_at: Date.now(),
            type: 'panel_payment',
            order_id: orderId
        };
        saveDb();
        await ctx.replyWithPhoto({ source: qrBuffer }, {
            caption: `Pembayaran QRIS\n\nTotal: ${toRupiah(amount)}\nOrder ID: ${orderId}\n\nSilakan scan QR code untuk melakukan pembayaran.`,
            ...Markup.inlineKeyboard([
                [Markup.button.callback('Cek Status Pembayaran', `cek_panel_${orderId}`)],
                [Markup.button.callback('Kembali ke Menu', 'back_to_menu')]
            ])
        });
    } catch (err) {
        console.error('QRIS Error:', err?.response?.data || err?.message || err);
        ctx.reply('Error saat membuat pembayaran QRIS. Silakan coba lagi.');
    }
});

// cek panel payment
bot.action(/cek_panel_(.*)/, async (ctx) => {
    try {
        const orderId = ctx.match[1];
        const order = db.orders[orderId];
        if (!order) return ctx.reply('Order tidak ditemukan.');
        await ctx.answerCbQuery('Mengecek status pembayaran...');
        const check = await axios.get(`https://ciaatopup.my.id/h2h/deposit/status?id=${order.trx}`, {
            headers: { 'X-APIKEY': global.pay.apikey }
        });
        if (check.data && check.data.success && check.data.data.status.toLowerCase() === 'success') {
            order.status = 'success';
            if (db.topups[order.trx]) db.topups[order.trx].status = 'success';
            saveDb();
            await safeEdit(ctx, 'Pembayaran berhasil!\nMembuat panel...');
            try {
                await createPanelTelegram(ctx, order);
            } catch (panelError) {
                console.error('Error creating panel after payment:', panelError);
                await ctx.reply('❌ Gagal membuat panel. Silakan hubungi admin.');
            }
        } else {
            await safeEdit(ctx, 'Pembayaran belum diterima atau masih diproses.', Markup.inlineKeyboard([
                [Markup.button.callback('Cek Lagi', `cek_panel_${orderId}`)],
                [Markup.button.callback('Kembali', 'back_to_menu')]
            ]));
        }
    } catch (err) {
        console.error('Cek Panel Error:', err?.response?.data || err?.message || err);
        await ctx.reply('Error saat mengecek status pembayaran.');
    }
});

// ========================
// SALDO / TOPUP FLOW
// ========================
bot.command('saldo', (ctx) => {
    const tgId = String(ctx.from.id);
    db.users[tgId] = db.users[tgId] || { saldo: 0 };
    ctx.reply(
        `*SALDO AKUN*\n\nSaldo Anda: ${toRupiah(db.users[tgId].saldo)}`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('Topup Saldo', 'topup_saldo')],
                [Markup.button.callback('Refresh', 'refresh_saldo')],
                [Markup.button.callback('Kembali', 'back_to_menu')]
            ])
        }
    );
});

bot.action('refresh_saldo', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const tgId = String(ctx.from.id);
        db.users[tgId] = db.users[tgId] || { saldo: 0 };
        await safeEdit(ctx,
            `*SALDO AKUN*\n\nSaldo Anda: ${toRupiah(db.users[tgId].saldo)}`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('Topup Saldo', 'topup_saldo')],
                    [Markup.button.callback('Refresh', 'refresh_saldo')],
                    [Markup.button.callback('Kembali', 'back_to_menu')]
                ])
            }
        );
    } catch (e) {
        console.error('Error in refresh_saldo:', e);
        ctx.reply('Terjadi error saat refresh saldo. Silakan coba lagi.');
    }
});

// topup menu
bot.command('topup', (ctx) => {
    ctx.reply('Pilih nominal topup:', Markup.inlineKeyboard([
        [Markup.button.callback('Rp 5.000', 'topup_5000'), Markup.button.callback('Rp 10.000', 'topup_10000')],
        [Markup.button.callback('Rp 20.000', 'topup_20000'), Markup.button.callback('Rp 50.000', 'topup_50000')],
        [Markup.button.callback('Rp 100.000', 'topup_100000'), Markup.button.callback('Lainnya', 'topup_custom')],
        [Markup.button.callback('Kembali', 'back_to_menu')]
    ]));
});

const topupAmounts = {
    topup_5000: 5000,
    topup_10000: 10000,
    topup_20000: 20000,
    topup_50000: 50000,
    topup_100000: 100000
};

Object.keys(topupAmounts).forEach(k => {
    bot.action(k, async (ctx) => {
        await ctx.answerCbQuery();
        await processTopup(ctx, topupAmounts[k]);
    });
});

bot.action('topup_custom', (ctx) => {
    ctx.answerCbQuery();
    setSession(ctx.chat.id, { step: 'waiting_topup_custom', user: ctx.from.id });
    ctx.reply('Masukkan nominal topup (minimal Rp 2.000):', Markup.keyboard([['Kembali ke Menu']]).oneTime().resize());
});

// processTopup
async function processTopup(ctx, nominal) {
    try {
        if (!global.pay.apikey) return ctx.reply('Payment gateway belum dikonfigurasi.');
        if (nominal < 2000) return ctx.reply('Minimal topup Rp 2.000.');
        const create = await axios.get(`https://ciaatopup.my.id/h2h/deposit/create?nominal=${nominal}&metode=${global.pay.metode}`, {
            headers: { 'X-APIKEY': global.pay.apikey }
        });
        if (!create.data || !create.data.success) {
            console.error('Topup create failed:', create.data);
            return ctx.reply('Gagal membuat pembayaran. Silakan coba lagi.');
        }
        const pay = create.data.data;
        const qrBuffer = await QRCode.toBuffer(pay.qr_string, { width: 300 });
        const topupId = genOrderId();
        db.topups[pay.id] = {
            user_id: String(ctx.from.id),
            nominal,
            status: 'pending',
            created_at: Date.now(),
            topup_id: topupId,
            type: 'saldo_topup'
        };
        saveDb();
        await ctx.replyWithPhoto({ source: qrBuffer }, {
            caption: `TOPUP SALDO\n\nNominal: ${toRupiah(nominal)}\nMetode: QRIS\nID: ${topupId}\n\nSilakan scan QR code di atas untuk melakukan pembayaran.`,
            ...Markup.inlineKeyboard([
                [Markup.button.callback('Cek Status Topup', `cek_topup_${pay.id}`)],
                [Markup.button.callback('Topup Lain', 'topup_saldo')],
                [Markup.button.callback('Kembali', 'back_to_menu')]
            ])
        });
    } catch (err) {
        console.error('Topup Error:', err?.response?.data || err?.message || err);
        ctx.reply('Error saat membuat topup. Silakan coba lagi.');
    }
}

// cek topup
bot.command('cek_topup', async (ctx) => {
    try {
        const userId = String(ctx.from.id);
        const userTopups = Object.entries(db.topups).filter(([id, topup]) => topup.user_id === userId && topup.type === 'saldo_topup').slice(-5);
        if (userTopups.length === 0) {
            return ctx.reply('Belum ada riwayat topup.', Markup.inlineKeyboard([
                [Markup.button.callback('Topup Sekarang', 'topup_saldo')],
                [Markup.button.callback('Kembali', 'back_to_menu')]
            ]));
        }
        let message = 'RIWAYAT TOPUP TERAKHIR\n\n';
        userTopups.forEach(([id, topup], index) => {
            const status = topup.status === 'success' ? '✅ Berhasil' : '⏳ Pending';
            message += `${index + 1}. ${toRupiah(topup.nominal)} - ${status}\n`;
        });
        ctx.reply(message, Markup.inlineKeyboard([
            [Markup.button.callback('Refresh Status', 'refresh_topup_list')],
            [Markup.button.callback('Topup Baru', 'topup_saldo')],
            [Markup.button.callback('Kembali', 'back_to_menu')]
        ]));
    } catch (err) {
        console.error('Error in /cek_topup:', err);
        ctx.reply('Terjadi error saat menampilkan riwayat topup.');
    }
});

bot.action(/cek_topup_(.*)/, async (ctx) => {
    try {
        const topupTrxId = ctx.match[1];
        const topup = db.topups[topupTrxId];
        if (!topup) return ctx.reply('Data topup tidak ditemukan.');
        await ctx.answerCbQuery('Mengecek status topup...');
        const check = await axios.get(`https://ciaatopup.my.id/h2h/deposit/status?id=${topupTrxId}`, {
            headers: { 'X-APIKEY': global.pay.apikey }
        });
        if (check.data && check.data.success && check.data.data.status.toLowerCase() === 'success') {
            topup.status = 'success';
            const userId = String(ctx.from.id);
            db.users[userId] = db.users[userId] || { saldo: 0 };
            db.users[userId].saldo += topup.nominal;
            saveDb();
            await safeEdit(ctx, `✅ TOPUP BERHASIL!\n\nNominal: ${toRupiah(topup.nominal)}\nSaldo bertambah: ${toRupiah(topup.nominal)}\n\nSaldo sekarang: ${toRupiah(db.users[userId].saldo)}`, Markup.inlineKeyboard([
                [Markup.button.callback('Topup Lagi', 'topup_saldo')],
                [Markup.button.callback('Cek Saldo', 'refresh_saldo')],
                [Markup.button.callback('Kembali', 'back_to_menu')]
            ]));
        } else {
            await safeEdit(ctx, '⏳ Topup masih menunggu pembayaran atau diproses.', Markup.inlineKeyboard([
                [Markup.button.callback('Cek Lagi', `cek_topup_${topupTrxId}`)],
                [Markup.button.callback('Kembali', 'back_to_menu')]
            ]));
        }
    } catch (err) {
        console.error('Cek Topup Error:', err?.response?.data || err?.message || err);
        ctx.reply('Error saat mengecek status topup.');
    }
});

bot.action('refresh_topup_list', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = String(ctx.from.id);
        const userTopups = Object.entries(db.topups).filter(([id, topup]) => topup.user_id === userId && topup.type === 'saldo_topup').slice(-5);
        if (userTopups.length === 0) {
            return safeEdit(ctx, 'Belum ada riwayat topup.', Markup.inlineKeyboard([
                [Markup.button.callback('Topup Sekarang', 'topup_saldo')],
                [Markup.button.callback('Kembali', 'back_to_menu')]
            ]));
        }
        let message = 'RIWAYAT TOPUP TERAKHIR\n\n';
        userTopups.forEach(([id, topup], index) => {
            const status = topup.status === 'success' ? '✅ Berhasil' : '⏳ Pending';
            message += `${index + 1}. ${toRupiah(topup.nominal)} - ${status}\n`;
        });
        await safeEdit(ctx, message, Markup.inlineKeyboard([
            [Markup.button.callback('Refresh Status', 'refresh_topup_list')],
            [Markup.button.callback('Topup Baru', 'topup_saldo')],
            [Markup.button.callback('Kembali', 'back_to_menu')]
        ]));
    } catch (err) {
        console.error('Error in refresh_topup_list:', err);
        ctx.reply('Terjadi error saat refresh riwayat topup.');
    }
});

// ========================
// ORDER FLOW - FULL BUTTON VERSION WITH PAGINATION
// ========================

// Fungsi untuk membuat keyboard produk dengan pagination
function generateProductKeyboard(session, page = 0) {
    const products = session.products;
    const providers = {};
    const productsPerPage = session.products_per_page || 10;
    
    // Group by provider
    products.forEach(product => {
        if (!providers[product.provider]) {
            providers[product.provider] = [];
        }
        providers[product.provider].push(product);
    });

    // Hitung total produk dan pages
    const totalProducts = products.length;
    const totalPages = Math.ceil(totalProducts / productsPerPage);
    
    // Validasi page number
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    
    // Hitung start dan end index
    const startIndex = currentPage * productsPerPage;
    const endIndex = Math.min(startIndex + productsPerPage, totalProducts);
    
    // Buat keyboard
    const productButtons = [];
    let displayedCount = 0;
    const productMap = {};

    Object.keys(providers).forEach(provider => {
        const providerProducts = providers[provider];
        let providerDisplayed = 0;
        
        // Filter produk yang akan ditampilkan di halaman ini
        const productsToShow = providerProducts.filter(product => {
            const globalIndex = products.findIndex(p => p.code === product.code);
            return globalIndex >= startIndex && globalIndex < endIndex;
        });

        if (productsToShow.length > 0) {
            // Tambahkan header provider
            productButtons.push([
                Markup.button.callback(
                    `📱 ${provider}`,
                    `provider_header_${provider}`,
                    true
                )
            ]);

            // Tambahkan produk per provider
            productsToShow.forEach(product => {
                const price = parseInt(product.price);
                const globalIndex = products.findIndex(p => p.code === product.code);
                
                productMap[globalIndex] = {
                    code: product.code,
                    name: product.name,
                    price: price,
                    provider: product.provider
                };

                productButtons.push([
                    Markup.button.callback(
                        `${displayedCount + 1}. ${product.name} - Rp${price.toLocaleString('id-ID')}`,
                        `order_product_${globalIndex}_page_${currentPage}`
                    )
                ]);
                displayedCount++;
                providerDisplayed++;
            });

            // Tambahkan separator jika ada produk dari provider lain
            if (providerDisplayed > 0) {
                productButtons.push([]);
            }
        }
    });

    // Hapus array kosong terakhir jika ada
    if (productButtons.length > 0 && productButtons[productButtons.length - 1].length === 0) {
        productButtons.pop();
    }

    // Tambahkan navigation pagination
    const navButtons = [];
    
    if (totalPages > 1) {
        if (currentPage > 0) {
            navButtons.push(Markup.button.callback('⬅️ Sebelumnya', `product_page_${currentPage - 1}`));
        }
        
        // Tombol info halaman (non-clickable)
        navButtons.push(
            Markup.button.callback(
                `📄 ${currentPage + 1}/${totalPages}`,
                'page_info',
                true
            )
        );
        
        if (currentPage < totalPages - 1) {
            navButtons.push(Markup.button.callback('Selanjutnya ➡️', `product_page_${currentPage + 1}`));
        }
        
        productButtons.push(navButtons);
    }

    // Tambahkan navigation buttons
    productButtons.push([
        Markup.button.callback('◀️ Kembali ke Kategori', 'order_back_to_categories'),
        Markup.button.callback('🔙 Batalkan', 'back_to_menu')
    ]);

    return {
        keyboard: productButtons,
        product_map: productMap,
        current_page: currentPage,
        displayed_count: displayedCount
    };
}

bot.command('order', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ').slice(1);
        const target = args[0];

        if (!target) {
            return ctx.reply(
                '📦 *FORMAT ORDER*\n\nMasukkan tujuan order:\nContoh: /order 08123456789\n\nAtau ketik tujuan di bawah:',
                {
                    parse_mode: 'Markdown',
                    ...Markup.keyboard([
                        ['/order 08123456789', '/order 628123456789'],
                        ['Kembali ke Menu']
                    ]).oneTime().resize()
                }
            );
        }

        notifyOwners(`User /order: @${ctx.from.username || ctx.from.id} -> ${target}`);
        
        const priceData = await getPriceList();
        if (!priceData || !priceData.success) {
            return ctx.reply(
                '❌ Gagal mengambil data produk. Silakan coba lagi nanti.',
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Coba Lagi', 'retry_order')],
                    [Markup.button.callback('🔙 Kembali ke Menu', 'back_to_menu')]
                ])
            );
        }

        const categories = groupProductsByCategory(priceData.data);
        const categoryList = Object.keys(categories);
        
        if (categoryList.length === 0) {
            return ctx.reply(
                '❌ Tidak ada produk yang tersedia saat ini.',
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Coba Lagi', 'retry_order')],
                    [Markup.button.callback('🔙 Kembali ke Menu', 'back_to_menu')]
                ])
            );
        }

        // Simpan session di memory
        const sessionId = `${ctx.chat.id}:${ctx.from.id}`;
        orderSessions.set(sessionId, {
            step: 'order_choose_category',
            user: ctx.from.id,
            order_target: target,
            categories: categories,
            categoryList: categoryList,
            timestamp: Date.now()
        });

        // Buat keyboard untuk kategori
        const categoryButtons = [];
        categoryList.forEach((category, index) => {
            const productCount = categories[category].length;
            categoryButtons.push([
                Markup.button.callback(
                    `${index + 1}. ${category} (${productCount})`, 
                    `order_category_${index}`
                )
            ]);
        });

        categoryButtons.push([Markup.button.callback('🔙 Batalkan Order', 'back_to_menu')]);

        await ctx.reply(
            `📦 *PILIH KATEGORI PRODUK*\n\n🎯 *Tujuan:* ${target}\n📊 *Total Kategori:* ${categoryList.length}\n\nPilih kategori:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(categoryButtons)
            }
        );

    } catch (error) {
        console.error('Error in /order command:', error);
        ctx.reply(
            '❌ Terjadi error saat memproses permintaan.',
            Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Coba Lagi', 'retry_order')],
                [Markup.button.callback('🔙 Kembali ke Menu', 'back_to_menu')]
            ])
        );
    }
});

// Handler untuk memilih kategori dengan button
bot.action(/order_category_(\d+)/, async (ctx) => {
    try {
        const categoryIndex = parseInt(ctx.match[1]);
        const sessionId = `${ctx.chat.id}:${ctx.from.id}`;
        const session = orderSessions.get(sessionId);

        if (!session || session.step !== 'order_choose_category') {
            return ctx.editMessageText(
                '❌ Session expired. Silakan mulai ulang dengan /order <tujuan>',
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Order Baru', 'retry_order')],
                    [Markup.button.callback('🔙 Kembali ke Menu', 'back_to_menu')]
                ])
            );
        }

        const categories = session.categories;
        const categoryList = session.categoryList;
        
        if (categoryIndex < 0 || categoryIndex >= categoryList.length) {
            return ctx.answerCbQuery('❌ Pilihan kategori tidak valid.', { show_alert: true });
        }

        const selectedCategory = categoryList[categoryIndex];
        const products = categories[selectedCategory];

        // Generate keyboard untuk halaman pertama
        const keyboardData = generateProductKeyboard({
            products: products,
            products_per_page: 10
        }, 0);

        // Update session dengan data pagination
        orderSessions.set(sessionId, {
            ...session,
            step: 'order_choose_product',
            selected_category: selectedCategory,
            products: products,
            product_map: keyboardData.product_map,
            product_count: products.length,
            current_page: keyboardData.current_page,
            products_per_page: 10,
            timestamp: Date.now()
        });

        await ctx.editMessageText(
            `🛒 *PILIH PRODUK - ${selectedCategory.toUpperCase()}*\n\n🎯 *Tujuan:* ${session.order_target}\n📊 *Total Produk:* ${products.length}\n📄 *Halaman:* ${keyboardData.current_page + 1}/${Math.ceil(products.length / 10)}\n\nPilih produk:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(keyboardData.keyboard)
            }
        );

        await ctx.answerCbQuery();

    } catch (error) {
        console.error('Error in category selection:', error);
        ctx.answerCbQuery('❌ Error memilih kategori.', { show_alert: true });
    }
});

// Handler untuk header provider (disabled button)
bot.action(/provider_header_(.*)/, async (ctx) => {
    await ctx.answerCbQuery(`📱 ${ctx.match[1]}`, { show_alert: true });
});

// Handler untuk navigasi halaman produk
bot.action(/product_page_(\d+)/, async (ctx) => {
    try {
        const newPage = parseInt(ctx.match[1]);
        const sessionId = `${ctx.chat.id}:${ctx.from.id}`;
        const session = orderSessions.get(sessionId);

        if (!session || session.step !== 'order_choose_product') {
            return ctx.answerCbQuery('❌ Session expired.', { show_alert: true });
        }

        // Generate keyboard untuk halaman yang diminta
        const keyboardData = generateProductKeyboard(session, newPage);

        // Update session dengan page baru dan product_map yang diperbarui
        orderSessions.set(sessionId, {
            ...session,
            product_map: keyboardData.product_map,
            current_page: keyboardData.current_page,
            timestamp: Date.now()
        });

        await ctx.editMessageText(
            `🛒 *PILIH PRODUK - ${session.selected_category.toUpperCase()}*\n\n🎯 *Tujuan:* ${session.order_target}\n📊 *Total Produk:* ${session.products.length}\n📄 *Halaman:* ${keyboardData.current_page + 1}/${Math.ceil(session.products.length / session.products_per_page)}\n\nPilih produk:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(keyboardData.keyboard)
            }
        );

        await ctx.answerCbQuery();

    } catch (error) {
        console.error('Error in pagination:', error);
        ctx.answerCbQuery('❌ Error mengganti halaman.', { show_alert: true });
    }
});

// Handler untuk info halaman (non-clickable)
bot.action('page_info', async (ctx) => {
    await ctx.answerCbQuery('📊 Informasi halaman', { show_alert: false });
});

// Handler untuk kembali ke kategori
bot.action('order_back_to_categories', async (ctx) => {
    try {
        const sessionId = `${ctx.chat.id}:${ctx.from.id}`;
        const session = orderSessions.get(sessionId);

        if (!session) {
            return ctx.editMessageText(
                '❌ Session expired.',
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Order Baru', 'retry_order')],
                    [Markup.button.callback('🔙 Kembali ke Menu', 'back_to_menu')]
                ])
            );
        }

        const categories = session.categories;
        const categoryList = session.categoryList;

        // Buat keyboard untuk kategori
        const categoryButtons = [];
        categoryList.forEach((category, index) => {
            const productCount = categories[category].length;
            categoryButtons.push([
                Markup.button.callback(
                    `${index + 1}. ${category} (${productCount})`, 
                    `order_category_${index}`
                )
            ]);
        });

        categoryButtons.push([Markup.button.callback('🔙 Batalkan Order', 'back_to_menu')]);

        await ctx.editMessageText(
            `📦 *PILIH KATEGORI PRODUK*\n\n🎯 *Tujuan:* ${session.order_target}\n📊 *Total Kategori:* ${categoryList.length}\n\nPilih kategori:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(categoryButtons)
            }
        );

        await ctx.answerCbQuery();

    } catch (error) {
        console.error('Error going back to categories:', error);
        ctx.answerCbQuery('❌ Error.', { show_alert: true });
    }
});

// Handler untuk memilih produk dengan PAGINATION
bot.action(/order_product_(\d+)_page_(\d+)/, async (ctx) => {
    try {
        const productIndex = parseInt(ctx.match[1]);
        const pageNum = parseInt(ctx.match[2]);
        const sessionId = `${ctx.chat.id}:${ctx.from.id}`;
        const session = orderSessions.get(sessionId);

        if (!session || session.step !== 'order_choose_product') {
            return ctx.editMessageText(
                '❌ Session expired. Silakan mulai ulang dengan /order <tujuan>',
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Order Baru', 'retry_order')],
                    [Markup.button.callback('🔙 Kembali ke Menu', 'back_to_menu')]
                ])
            );
        }

        // Validasi page number
        if (pageNum !== session.current_page) {
            return ctx.answerCbQuery('❌ Halaman sudah berubah. Silakan refresh.', { show_alert: true });
        }

        if (!session.product_map || productIndex < 0 || productIndex >= session.product_count) {
            return ctx.answerCbQuery('❌ Pilihan produk tidak valid.', { show_alert: true });
        }

        const productData = session.product_map[productIndex];
        const userSaldo = db.users[String(ctx.from.id)]?.saldo || 0;
        
        const orderId = genOrderId();
        db.orders[orderId] = {
            id: orderId,
            user_id: String(ctx.from.id),
            tujuan: session.order_target,
            product_code: productData.code,
            product_name: productData.name,
            category: session.selected_category,
            provider: productData.provider,
            harga: productData.price,
            status: 'draft',
            created_at: Date.now()
        };

        // Clear session setelah order dibuat
        orderSessions.delete(sessionId);
        saveDb();
        
        let message = `📋 *DETAIL ORDER*\n\n`;
        message += `🆔 *Order ID:* ${orderId}\n`;
        message += `📦 *Produk:* ${productData.name}\n`;
        message += `🏷️ *Provider:* ${productData.provider}\n`;
        message += `📂 *Kategori:* ${session.selected_category}\n`;
        message += `🎯 *Tujuan:* ${session.order_target}\n`;
        message += `💳 *Harga:* Rp${productData.price.toLocaleString('id-ID')}\n`;
        message += `💰 *Saldo Anda:* Rp${userSaldo.toLocaleString('id-ID')}\n\n`;
        message += `Pilih metode pembayaran:`;

        const keyboard = [];
        
        if (userSaldo >= productData.price) {
            keyboard.push([Markup.button.callback('💳 Bayar dengan Saldo', `order_saldo_${orderId}`)]);
        } else {
            keyboard.push([
                Markup.button.callback(
                    `💳 Saldo Tidak Cukup (Butuh Rp${(productData.price - userSaldo).toLocaleString('id-ID')})`,
                    'insufficient_balance',
                    true
                )
            ]);
        }
        
        keyboard.push([Markup.button.callback('📱 Bayar dengan QRIS', `order_qris_${orderId}`)]);
        
        keyboard.push([
            Markup.button.callback('🔄 Pilih Produk Lain', 'order_back_to_products'),
            Markup.button.callback('🔙 Kembali ke Menu', 'back_to_menu')
        ]);

        await ctx.editMessageText(message, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(keyboard)
        });

        await ctx.answerCbQuery();

    } catch (error) {
        console.error('Error in product selection:', error);
        ctx.answerCbQuery('❌ Error memilih produk.', { show_alert: true });
    }
});

// Handler untuk kembali ke produk dari detail order
bot.action('order_back_to_products', async (ctx) => {
    try {
        const sessionId = `${ctx.chat.id}:${ctx.from.id}`;
        const session = orderSessions.get(sessionId);

        if (!session || !session.products) {
            return ctx.editMessageText(
                '❌ Tidak dapat kembali ke produk. Silakan mulai ulang.',
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Order Baru', 'retry_order')],
                    [Markup.button.callback('🔙 Kembali ke Menu', 'back_to_menu')]
                ])
            );
        }

        // Generate keyboard untuk halaman terakhir yang dilihat
        const keyboardData = generateProductKeyboard(session, session.current_page || 0);

        // Update session
        orderSessions.set(sessionId, {
            ...session,
            product_map: keyboardData.product_map,
            current_page: keyboardData.current_page,
            timestamp: Date.now()
        });

        await ctx.editMessageText(
            `🛒 *PILIH PRODUK - ${session.selected_category.toUpperCase()}*\n\n🎯 *Tujuan:* ${session.order_target}\n📊 *Total Produk:* ${session.products.length}\n📄 *Halaman:* ${keyboardData.current_page + 1}/${Math.ceil(session.products.length / session.products_per_page)}\n\nPilih produk:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(keyboardData.keyboard)
            }
        );

        await ctx.answerCbQuery();

    } catch (error) {
        console.error('Error going back to products:', error);
        ctx.answerCbQuery('❌ Error.', { show_alert: true });
    }
});

// Handler untuk button saldo tidak cukup
bot.action('insufficient_balance', async (ctx) => {
    await ctx.answerCbQuery('❌ Saldo tidak cukup. Silakan topup saldo terlebih dahulu.', { show_alert: true });
});

// Handler untuk retry order
bot.action('retry_order', async (ctx) => {
    try {
        await ctx.deleteMessage();
        await ctx.reply(
            '📦 *FORMAT ORDER*\n\nMasukkan tujuan order:\nContoh: /order 08123456789\n\nAtau ketik tujuan di bawah:',
            {
                parse_mode: 'Markdown',
                ...Markup.keyboard([
                    ['/order 08123456789', '/order 628123456789'],
                    ['Kembali ke Menu']
                ]).oneTime().resize()
            }
        );
    } catch (error) {
        ctx.reply('Silakan gunakan /order <tujuan> untuk memulai order baru.');
    }
});

// PAYMENT HANDLERS untuk order
bot.action(/order_qris_(.*)/, async (ctx) => {
    try {
        const orderId = ctx.match[1];
        const order = db.orders[orderId];
        if (!order) return ctx.reply('Order tidak ditemukan.');
        await ctx.answerCbQuery();
        const amount = Number(order.harga) + rand(100, 250);
        const create = await axios.get(`https://ciaatopup.my.id/h2h/deposit/create?nominal=${amount}&metode=${global.pay.metode}`, {
            headers: { 'X-APIKEY': global.pay.apikey }
        });
        if (!create.data || !create.data.success) return ctx.editMessageText('Gagal membuat pembayaran QRIS. Silakan coba lagi.');
        const pay = create.data.data;
        const qrBuffer = await QRCode.toBuffer(pay.qr_string, { width: 300 });
        order.status = 'pending_payment';
        order.metode = 'qris';
        order.nominal = amount;
        order.trx = pay.id;
        order.updated_at = Date.now();
        db.topups[pay.id] = {
            user_id: String(ctx.from.id),
            nominal: amount,
            status: 'pending',
            created_at: Date.now(),
            type: 'order_payment',
            order_id: orderId
        };
        saveDb();
        await ctx.replyWithPhoto({ source: qrBuffer }, {
            caption: `PAYMENT ORDER\n\nLayanan: ${order.product_name}\nTujuan: ${order.tujuan}\nTotal: ${toRupiah(amount)}\nOrder ID: ${orderId}\n\nSilakan scan QR code untuk melakukan pembayaran.`,
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Cek Status Pembayaran', `cek_order_${orderId}`)],
                [Markup.button.callback('🔙 Kembali ke Menu', 'back_to_menu')]
            ])
        });
    } catch (err) {
        console.error('Order QRIS Error:', err?.response?.data || err?.message || err);
        ctx.reply('Error saat membuat pembayaran QRIS untuk order.');
    }
});

bot.action(/cek_order_(.*)/, async (ctx) => {
    try {
        const orderId = ctx.match[1];
        const order = db.orders[orderId];
        if (!order || !order.trx) return ctx.reply('Order tidak ditemukan.');
        await ctx.answerCbQuery('Mengecek status pembayaran...');
        const check = await axios.get(`https://ciaatopup.my.id/h2h/deposit/status?id=${order.trx}`, {
            headers: { 'X-APIKEY': global.pay.apikey }
        });
        if (check.data && check.data.success && check.data.data.status.toLowerCase() === 'success') {
            order.status = 'success';
            order.updated_at = Date.now();
            if (db.topups[order.trx]) db.topups[order.trx].status = 'success';
            saveDb();
            await safeEdit(ctx, `✅ ORDER BERHASIL!\n\nLayanan: ${order.product_name}\nTujuan: ${order.tujuan}\nTotal: ${toRupiah(order.nominal)}\n\nOrder sedang diproses...`, Markup.inlineKeyboard([
                [Markup.button.callback('🛒 Order Lagi', 'order_again')],
                [Markup.button.callback('🔙 Kembali', 'back_to_menu')]
            ]));
        } else {
            await safeEdit(ctx, '⏳ Pembayaran belum diterima atau masih diproses.', Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Cek Lagi', `cek_order_${orderId}`)],
                [Markup.button.callback('🔙 Kembali', 'back_to_menu')]
            ]));
        }
    } catch (err) {
        console.error('Cek Order Error:', err?.response?.data || err?.message || err);
        ctx.reply('Error saat mengecek status pembayaran order.');
    }
});

bot.action(/order_saldo_(.*)/, async (ctx) => {
    try {
        const orderId = ctx.match[1];
        const order = db.orders[orderId];
        const userId = String(ctx.from.id);
        if (!order) return ctx.reply('Order tidak ditemukan.');
        await ctx.answerCbQuery();
        db.users[userId] = db.users[userId] || { saldo: 0 };
        if (db.users[userId].saldo < order.harga) {
            return safeEdit(ctx, `Saldo tidak cukup.\nButuh: ${toRupiah(order.harga)}\nSaldo: ${toRupiah(db.users[userId].saldo)}`, Markup.inlineKeyboard([
                [Markup.button.callback('💳 Topup Saldo', 'topup_saldo')],
                [Markup.button.callback('🔙 Kembali', 'back_to_menu')]
            ]));
        }
        db.users[userId].saldo -= order.harga;
        order.status = 'success';
        order.metode = 'saldo';
        order.updated_at = Date.now();
        saveDb();
        await safeEdit(ctx, `✅ ORDER BERHASIL!\n\nLayanan: ${order.product_name}\nTujuan: ${order.tujuan}\nTotal: ${toRupiah(order.harga)}\n\nOrder sedang diproses...`, Markup.inlineKeyboard([
            [Markup.button.callback('🛒 Order Lagi', 'order_again')],
            [Markup.button.callback('🔙 Kembali', 'back_to_menu')]
        ]));
    } catch (err) {
        console.error('order_saldo error', err);
        ctx.reply('Error saat memproses pembayaran dengan saldo.');
    }
});

// ORDER AGAIN / BACK MENU
bot.action('order_again', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    ctx.deleteMessage().catch(() => {});
    ctx.reply('Masukkan nomor tujuan untuk order:\nFormat: /order <tujuan>\nContoh: /order 08123456789');
});

bot.action('back_to_menu', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        try { await ctx.deleteMessage(); } catch (e) {}
        await bot.telegram.sendMessage(ctx.chat.id, 'Pilih layanan:', Markup.keyboard([
            ['/order', '/buypanel'],
            ['/saldo', '/topup'],
            ['/cek_topup', isOwner(ctx.from.id) ? '/menu_owner' : '/cek_topup'].filter(Boolean)
        ]).resize());
    } catch (err) {
        console.error('Error in back_to_menu:', err);
        ctx.reply('Kembali ke menu utama. Gunakan /start untuk melihat menu.');
    }
});

// ========================
// CREATE PANEL PTERODACTYL
// ========================
async function createPanelTelegram(ctx, data) {
    try {
        const username = data.username;
        const email = `${username}@no-reply.local`;
        const password = `${username}${Math.floor(Math.random()*9000+1000)}`;
        
        let userId = 1;
        try {
            const userResp = await axios.post(`${global.domain}/api/application/users`, {
                email, username, first_name: username, last_name: 'Panel', password
            }, {
                headers: { Authorization: `Bearer ${global.apikey}`, 'Content-Type': 'application/json' }
            });
            userId = userResp.data.attributes.id || userId;
        } catch (e) {
            console.warn('create user failed, continue with default user:', e?.response?.data || e?.message || e);
        }

        let eggDetails = { startup: 'npm start', docker_image: 'ghcr.io/parkervcp/yolks:nodejs_18', variables: [] };
        try {
            const eggResponse = await axios.get(`${global.domain}/api/application/nests/${global.nestid}/eggs/${global.egg}?include=variables`, {
                headers: { Authorization: `Bearer ${global.apikey}` }
            });
            if (eggResponse.data && eggResponse.data.attributes) {
                eggDetails = eggResponse.data.attributes;
            }
        } catch (err) {
            console.warn('Cannot get egg details, using defaults');
        }

        let allocationId;
        try {
            const allocResponse = await axios.get(`${global.domain}/api/application/nodes/${global.loc}/allocations`, {
                headers: { Authorization: `Bearer ${global.apikey}` }
            });
            const availableAlloc = allocResponse.data.data.find(a => a.attributes.assigned === false);
            if (!availableAlloc) throw new Error('Tidak ada port yang tersedia');
            allocationId = availableAlloc.attributes.id;
        } catch (e) {
            console.error('Allocation error:', e?.response?.data || e?.message || e);
            throw e;
        }

        const environment = {};
        environment.NODE_VERSION = '18';
        environment.USER_UPLOAD = '0';
        environment.AUTO_UPDATE = '0';
        
        try {
            const vars = eggDetails.relationships?.variables?.data || eggDetails.variables || [];
            (vars || []).forEach(v => {
                const attr = v.attributes || v;
                const key = attr.env_variable || attr.env;
                if (key) environment[key] = attr.default_value ?? '';
            });
        } catch (e) {
        }

        const limits = {
            memory: Number(data.ram),
            swap: 0,
            disk: Number(data.disk),
            io: 500,
            cpu: Number(data.cpu)
        };
        
        const serverData = {
            name: `${username}-panel`,
            user: Number(userId),
            egg: Number(global.egg),
            docker_image: eggDetails.docker_image || 'ghcr.io/parkervcp/yolks:nodejs_18',
            startup: eggDetails.startup || 'npm start',
            environment,
            skip_scripts: false,
            feature_limits: { databases: 1, backups: 1 },
            limits,
            allocation: { default: allocationId, additional: [] },
            deployment: {
                locations: [Number(global.loc)],
                dedicated_ip: false,
                port_range: []
            },
            start_on_completion: true
        };

        console.log('Creating server with payload snippet:', JSON.stringify(serverData).slice(0, 1000));
        
        const srv = await axios.post(`${global.domain}/api/application/servers`, serverData, {
            headers: {
                Authorization: `Bearer ${global.apikey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        
        const server = srv.data.attributes || srv.data;

        const ramText = data.ram >= 99999 ? 'Unlimited' : `${data.ram}MB`;
        const diskText = data.disk >= 99999 ? 'Unlimited' : `${data.disk}MB`;
        const cpuText = data.cpu === 0 ? 'Unlimited' : `${data.cpu}%`;

        await ctx.reply(
            `✅ PANEL BERHASIL DIBUAT!\n\nDetail Akun:\nUsername: ${username}\nPassword: ${password}\nEmail: ${email}\n\nDetail Server:\nRAM: ${ramText}\nDisk: ${diskText}\nCPU: ${cpuText}\n\nLogin URL:\n${global.domain}\n\nJoin Group Garansi\n${global.linkgc}`,
            Markup.inlineKeyboard([
                [Markup.button.url('Login Panel', global.domain)],
                [Markup.button.callback('Buat Panel Lagi', 'buypanel_again')],
                [Markup.button.callback('Kembali', 'back_to_menu')]
            ])
        );

        notifyOwners(`Panel dibuat untuk ${username} oleh ${ctx.from.username || ctx.from.id}`);

    } catch (err) {
        console.error('PANEL ERROR:', err?.response?.data || err?.message || err);
        let errorMessage = '❌ Gagal membuat panel:\n';
        if (err.response?.data?.errors) {
            err.response.data.errors.forEach(e => {
                errorMessage += `\n• ${e.detail || e.code || JSON.stringify(e)}`;
            });
        } else if (err.response?.data) {
            errorMessage += `\n${JSON.stringify(err.response.data).slice(0, 500)}`;
        } else {
            errorMessage += (err.message || String(err)).slice(0, 500);
        }
        await ctx.reply(errorMessage, Markup.inlineKeyboard([
            [Markup.button.callback('Coba Lagi', 'buypanel_again')],
            [Markup.button.callback('Kembali', 'back_to_menu')]
        ]));
        throw err;
    }
}

// buypanel again
bot.action('buypanel_again', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    ctx.deleteMessage().catch(() => {});
    ctx.reply('Masukkan username untuk panel baru:', Markup.keyboard([['Kembali ke Menu']]).oneTime().resize());
});

// ========================
// CHECK PENDING PAYMENTS (auto) - runs every 30s
// ========================
async function checkPendingPayments() {
    try {
        const now = Date.now();
        const pendingTopups = Object.entries(db.topups)
            .filter(([id, topup]) => topup.status === 'pending' && (now - topup.created_at) < global.pay.expiredMs);

        for (const [trxId, topup] of pendingTopups) {
            try {
                const check = await axios.get(`https://ciaatopup.my.id/h2h/deposit/status?id=${trxId}`, {
                    headers: { 'X-APIKEY': global.pay.apikey }
                });
                
                if (check.data && check.data.success && check.data.data.status.toLowerCase() === 'success') {
                    topup.status = 'success';
                    
                    if (topup.type === 'saldo_topup') {
                        const userId = String(topup.user_id);
                        db.users[userId] = db.users[userId] || { saldo: 0 };
                        db.users[userId].saldo += topup.nominal;
                        try {
                            await bot.telegram.sendMessage(userId, `✅ TOPUP TERKONFIRMASI!\nNominal: ${toRupiah(topup.nominal)}\nSaldo sekarang: ${toRupiah(db.users[userId].saldo)}`);
                        } catch (e) {
                            console.error('Notify topup user failed:', e?.message || e);
                        }
                    }
                    
                    if (topup.type === 'panel_payment') {
                        const order = db.orders[topup.order_id] || Object.values(db.orders).find(o => o.trx === trxId);
                        if (order && order.status !== 'success') {
                            order.status = 'success';
                            try {
                                await bot.telegram.sendMessage(topup.user_id, '✅ PEMBAYARAN PANEL TERKONFIRMASI!\nMembuat panel...');
                                const mockCtx = {
                                    reply: (msg, extra) => bot.telegram.sendMessage(topup.user_id, msg, extra),
                                    from: { id: topup.user_id },
                                    chat: { id: topup.user_id }
                                };
                                await createPanelTelegram(mockCtx, order);
                            } catch (err) {
                                console.error('Failed to create panel after payment check:', err);
                            }
                        }
                    }
                    
                    if (topup.type === 'order_payment') {
                        const order = db.orders[topup.order_id];
                        if (order && order.status !== 'success') {
                            order.status = 'success';
                            try {
                                await bot.telegram.sendMessage(topup.user_id, `✅ PEMBAYARAN ORDER TERKONFIRMASI!\nOrder: ${order.tujuan}\nTotal: ${toRupiah(order.nominal)}\nOrder sedang diproses...`);
                            } catch (e) {
                                console.error('Notify order user failed:', e?.message || e);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(`Error checking payment ${trxId}:`, error?.message || error);
            }
        }
        saveDb();
    } catch (err) {
        console.error('Error in checkPendingPayments:', err);
    }
}
setInterval(checkPendingPayments, 30 * 1000);

// ========================
// HANDLE TEXT for sessions + owner broadcast
// ========================
bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    const text = ctx.message.text;

    if (text.startsWith('/')) return;

    if (session) {
        if (session.step === 'waiting_username' && text !== 'Kembali ke Menu') {
            const username = String(text).toLowerCase().replace(/[^a-z0-9_-]/g, '');
            if (!username) return ctx.reply('Username tidak valid.');
            
            const tgId = String(session.user);
            db.users[tgId] = db.users[tgId] || { saldo: 0 };
            db.users[tgId].temp_username = username;
            clearSession(chatId);
            saveDb();
            
            return ctx.reply(
                `Pilih RAM untuk username ${username}`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('RAM 1GB - 1.000', 'ram_1gb')],
                    [Markup.button.callback('RAM 2GB - 2.000', 'ram_2gb')],
                    [Markup.button.callback('RAM 3GB - 3.000', 'ram_3gb')],
                    [Markup.button.callback('RAM 4GB - 4.000', 'ram_4gb')],
                    [Markup.button.callback('RAM Unlimited - 11.000', 'ram_unli')],
                    [Markup.button.callback('Kembali', 'back_to_menu')]
                ])
            );
        }

        if (session.step === 'waiting_topup_custom' && text !== 'Kembali ke Menu') {
            const nominal = Number(String(text).replace(/\D/g, ''));
            clearSession(chatId);
            saveDb();
            return processTopup(ctx, nominal);
        }

        if (session.step === 'owner_broadcast' && session.user && isOwner(session.user)) {
            clearSession(chatId);
            saveDb();
            const message = text;
            const userIds = Object.keys(db.users).slice(0, 500);
            
            ctx.reply(`Mengirim broadcast ke ${userIds.length} user...`);
            for (const uid of userIds) {
                try {
                    await bot.telegram.sendMessage(uid, `📢 BROADCAST:\n\n${message}`);
                } catch (e) {
                }
            }
            return ctx.reply('Broadcast terkirim.');
        }
    }

    if (text === 'Kembali ke Menu') {
        // Hanya clear non-order sessions
        if (session && session.step !== 'order_choose_category' && session.step !== 'order_choose_product') {
            clearSession(chatId);
            saveDb();
        }
        
        return ctx.reply('Pilih layanan:', Markup.keyboard([
            ['/order', '/buypanel'],
            ['/saldo', '/topup'],
            ['/cek_topup', isOwner(ctx.from.id) ? '/menu_owner' : '/cek_topup'].filter(Boolean)
        ]).resize());
    }
});

// ========================
// ERROR HANDLING & LAUNCH
// ========================
process.once('SIGINT', () => {
    console.log('Bot shutting down...');
    bot.stop('SIGINT');
    process.exit(0);
});
process.once('SIGTERM', () => {
    console.log('Bot shutting down...');
    bot.stop('SIGTERM');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}:`, err);
    try {
        ctx.reply('❌ Terjadi error, silakan coba lagi.', Markup.inlineKeyboard([[Markup.button.callback('Kembali ke Menu', 'back_to_menu')]]));
    } catch (e) {
        console.error('Failed to send error reply', e?.message || e);
    }
});

bot.launch().then(() => {
    console.log('Bot is running successfully');
}).catch(err => {
    console.error('Failed to start bot:', err);
});