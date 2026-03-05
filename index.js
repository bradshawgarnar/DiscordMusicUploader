const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Load config
const config = require('./config.json');
const ROBLOX_GROUP_ID = config.roblox.group_id;
const API_KEYS = config.roblox.api_keys.sort((a, b) => a.priority - b.priority);
const SETTINGS = config.settings;

// 🔒 Filter: Channel & Guild yang diizinkan (dari config)
const ALLOWED_CHANNELS = config.discord?.allowed_channel_ids || [];
const ALLOWED_GUILDS = config.discord?.allowed_guild_ids || [];

// Cache quota dan CSRF token
const quotaCache = new Map();  // key: cookie, value: { remaining, capacity, cachedAt }
const csrfCache = new Map();   // key: cookie, value: { token, cachedAt }
const CSRF_TTL = 5 * 60 * 1000;    // CSRF token cache 5 menit
const QUOTA_TTL = 10 * 60 * 1000;  // Quota cache 10 menit

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ==================== UTILITIES ====================

/**
 * Ambil X-CSRF-TOKEN dari Roblox secara otomatis.
 * Roblox sengaja return 403 + token di header saat hit /v2/logout.
 * @param {string} robloSecurity - Cookie .ROBLOSECURITY (tanpa prefix)
 * @returns {Promise<string>}
 */
async function getCsrfToken(robloSecurity) {
    const now = Date.now();
    const cached = csrfCache.get(robloSecurity);

    if (cached && now - cached.cachedAt < CSRF_TTL) {
        return cached.token;
    }

    try {
        await axios.post(
            'https://auth.roblox.com/v2/logout',
            {},
            { headers: { Cookie: `.ROBLOSECURITY=${robloSecurity}` } }
        );
    } catch (err) {
        const token = err.response?.headers?.['x-csrf-token'];
        if (token) {
            csrfCache.set(robloSecurity, { token, cachedAt: now });
            console.log(`[CSRF] Token berhasil didapat.`);
            return token;
        }
        throw new Error(`Gagal mendapatkan X-CSRF-TOKEN: ${err.message}`);
    }

    throw new Error('Gagal mendapatkan X-CSRF-TOKEN: tidak ada response error dari Roblox.');
}

/**
 * Cek quota upload audio menggunakan .ROBLOSECURITY cookie.
 * Endpoint: GET https://publish.roblox.com/v1/asset-quotas
 * @param {string} robloSecurity - Cookie .ROBLOSECURITY (tanpa prefix)
 * @returns {Promise<{available: boolean, remaining: number, capacity: number}>}
 */
async function checkQuota(robloSecurity) {
    const now = Date.now();
    const cached = quotaCache.get(robloSecurity);

    if (cached && now - cached.cachedAt < QUOTA_TTL) {
        console.log(`[Quota Cache] Sisa: ${cached.remaining}/${cached.capacity}`);
        return {
            available: cached.remaining > 0,
            remaining: cached.remaining,
            capacity: cached.capacity
        };
    }

    try {
        const csrfToken = await getCsrfToken(robloSecurity);

        const response = await axios.get(
            'https://publish.roblox.com/v1/asset-quotas',
            {
                params: {
                    resourceType: 'RateLimitUpload',
                    assetType: 'Audio'
                },
                headers: {
                    'Cookie': `.ROBLOSECURITY=${robloSecurity}`,
                    'X-CSRF-TOKEN': csrfToken,
                    'User-Agent': 'Mozilla/5.0'
                }
            }
        );

        const quota = response.data.quotas?.[0];
        if (!quota) throw new Error('Quota data tidak ditemukan dalam response.');

        const remaining = quota.capacity - quota.usage;
        const result = { remaining, capacity: quota.capacity };

        quotaCache.set(robloSecurity, { ...result, cachedAt: now });
        console.log(`[Quota] Sisa: ${remaining}/${quota.capacity}`);

        return { available: remaining > 0, remaining, capacity: quota.capacity };

    } catch (error) {
        const status = error.response?.status;
        const msg = error.response?.data?.errors?.[0]?.message || error.message;

        if (status === 403) {
            csrfCache.delete(robloSecurity); // Hapus cache agar refresh berikutnya
        }
        console.log(`[Quota] Gagal cek quota (${status || 'Unknown'}), lanjut tanpa quota check.`);

        // Gagal cek → anggap available agar tidak blocking upload
        return { available: true, remaining: -1, capacity: -1 };
    }
}

/**
 * Kurangi sisa quota di cache setelah upload sukses.
 * @param {string} robloSecurity
 */
function decrementQuotaCache(robloSecurity) {
    const cached = quotaCache.get(robloSecurity);
    if (cached && cached.remaining > 0) {
        cached.remaining -= 1;
        quotaCache.set(robloSecurity, cached);
        console.log(`[Quota] Cache dikurangi → sisa ${cached.remaining}/${cached.capacity}`);
    }
}

/**
 * Set remaining = 0 di cache jika Roblox return error quota exhausted.
 * @param {string} robloSecurity
 */
function invalidateQuotaCache(robloSecurity) {
    const cached = quotaCache.get(robloSecurity);
    if (cached) {
        cached.remaining = 0;
        quotaCache.set(robloSecurity, cached);
        console.log(`[Quota] Cache di-invalidate → sisa 0/${cached.capacity}`);
    }
}

/**
 * Cari API Key pertama yang masih memiliki quota tersedia.
 * Menggunakan cookie untuk cek quota via publish.roblox.com.
 * @returns {Promise<{apiKey: string, cookie: string|null, name: string} | null>}
 */
async function findAvailableApiKey() {
    for (const entry of API_KEYS) {
        if (!entry.cookie) {
            console.warn(`[Warning] ${entry.name} tidak memiliki cookie → skip quota check, langsung pakai.`);
            return { apiKey: entry.key, cookie: null, name: entry.name };
        }

        const quota = await checkQuota(entry.cookie);
        console.log(`[Quota] ${entry.name}: ${quota.remaining}/${quota.capacity} tersisa`);

        if (quota.available) {
            return { apiKey: entry.key, cookie: entry.cookie, name: entry.name };
        }

        console.log(`[Skip] ${entry.name} quota habis, mencoba key berikutnya...`);
    }

    return null; // Semua key habis
}

/**
 * Upload file audio ke Roblox dengan API Key tertentu.
 */
async function uploadToRoblox(filePath, fileName, apiKey) {
    const form = new FormData();

    form.append(
        'request',
        JSON.stringify({
            assetType: 'Audio',
            displayName: fileName,
            description: 'Audio',
            creationContext: {
                creator: {
                    groupId: parseInt(ROBLOX_GROUP_ID)
                }
            }
        }),
        { contentType: 'application/json' }
    );

    form.append('fileContent', fs.createReadStream(filePath));

    const uploadResponse = await axios.post(
        'https://apis.roblox.com/assets/v1/assets',
        form,
        {
            headers: {
                ...form.getHeaders(),
                'x-api-key': apiKey
            }
        }
    );

    return uploadResponse.data.path.split('/').pop(); // operationId
}

/**
 * Polling status operasi upload hingga done: true.
 * done: true hanya berarti upload selesai — BUKAN moderasi final.
 */
async function pollOperationStatus(operationId, apiKey, pollingInterval = 4000) {
    while (true) {
        const statusResponse = await axios.get(
            `https://apis.roblox.com/assets/v1/operations/${operationId}`,
            { headers: { 'x-api-key': apiKey } }
        );

        if (statusResponse.data.done) {
            return {
                assetId: statusResponse.data.response?.assetId || '-',
                status: statusResponse.data.response?.moderationResult?.moderationState || 'UNKNOWN'
            };
        }

        await new Promise(resolve => setTimeout(resolve, pollingInterval));
    }
}

/**
 * Polling status moderasi asset hingga mendapat status final (bukan REVIEWING).
 * Diperlukan karena moderasi audio Roblox berjalan async setelah upload selesai.
 * @param {string} assetId
 * @param {string} apiKey
 * @param {number} maxWaitMs - Default 5 menit
 * @returns {Promise<string>}
 */
async function pollModerationStatus(assetId, apiKey, maxWaitMs = 1800000) {
    const interval = 15000; // cek tiap 15 detik
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
        try {
            const res = await axios.get(
                `https://apis.roblox.com/assets/v1/assets/${assetId}`,
                { headers: { 'x-api-key': apiKey } }
            );

            const state = res.data?.moderationResult?.moderationState;
            const elapsed = Math.round((Date.now() - start) / 1000);
            console.log(`[Moderation] Asset ${assetId}: ${state} (${elapsed}s)`);

            // Roblox mengembalikan "Reviewing" (bukan MODERATION_STATE_REVIEWING)
            if (state && state.toLowerCase() !== 'reviewing') {
                return state;
            }

        } catch (err) {
            console.warn(`[Moderation Poll WARN] Asset ${assetId}: ${err.message}`);
        }

        await new Promise(r => setTimeout(r, interval));
    }

    return 'Timeout';
}

/**
 * Archive asset yang ditolak moderasi.
 * Endpoint: POST https://apis.roblox.com/assets/v1/assets/{assetId}:archive
 * @param {string} assetId
 * @param {string} apiKey
 */
async function archiveAsset(assetId, apiKey) {
    try {
        await axios.post(
            `https://apis.roblox.com/assets/v1/assets/${assetId}:archive`,
            {},
            { headers: { 'x-api-key': apiKey } }
        );
        console.log(`[Archive] Asset ${assetId} berhasil di-archive.`);
        return true;
    } catch (err) {
        console.warn(`[Archive WARN] Asset ${assetId}: ${err.message}`);
        return false;
    }
}

/**
 * Format status moderasi menjadi label yang mudah dibaca.
 */
function formatModerationStatus(state) {
    const map = {
        'approved': '✅ APPROVED',
        'rejected': '❌ REJECTED',
        'reviewing': '🔄 REVIEWING',
        'timeout': '⏰ TIMEOUT (>30 menit)',
    };
    return map[state?.toLowerCase()] || `⚠️ ${state}`;
}

// ==================== BOT EVENTS ====================

client.once('ready', () => {
    console.log(`✅ Bot login sebagai ${client.user.tag}`);
    console.log(`📊 Loaded ${API_KEYS.length} API Keys`);
    console.log(`🍪 Cookie tersedia: ${API_KEYS.filter(k => k.cookie).length}/${API_KEYS.length} key`);
    console.log(`🔒 Filter aktif: ${ALLOWED_CHANNELS.length} channel, ${ALLOWED_GUILDS.length} guild`);
});

client.on('messageCreate', async (message) => {
    // 🔒 FILTER 1: Hanya proses dari guild yang diizinkan
    if (ALLOWED_GUILDS.length > 0 && message.guild?.id && !ALLOWED_GUILDS.includes(message.guild.id)) {
        console.log(`[Ignored] Unauthorized guild: ${message.guild.name} (${message.guild.id})`);
        return;
    }

    // 🔒 FILTER 2: Hanya proses dari channel yang diizinkan
    if (ALLOWED_CHANNELS.length > 0 && !ALLOWED_CHANNELS.includes(message.channel.id)) {
        console.log(`[Ignored] Unauthorized channel: ${message.channel.id}`);
        return;
    }

    if (message.author.bot) return;

    if (message.attachments.size === 0) {
        return message.reply('📤 Upload file audio (mp3/ogg) untuk diproses.');
    }

    const attachmentList = [...message.attachments.values()];
    const uploadedAssets = []; // { name, assetId, apiKey, usedKey, quota }
    const results = [];

    // ========== FASE 1: UPLOAD SEMUA FILE ==========
    await message.reply(`📦 Memulai upload **${attachmentList.length}** file...`);

    for (const attachment of attachmentList) {
        if (!attachment.contentType?.startsWith('audio')) {
            results.push({
                name: attachment.name,
                id: '-',
                status: '❌ BUKAN FILE AUDIO'
            });
            continue;
        }

        const fileName = path.parse(attachment.name).name;
        const filePath = `./${attachment.name}`;
        let attempt = 0;
        const maxRetry = SETTINGS.max_retry_per_upload || 3;

        try {
            // Download file dari Discord
            const dlResponse = await axios.get(attachment.url, { responseType: 'stream' });
            const writer = fs.createWriteStream(filePath);
            dlResponse.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            // 🔁 Loop retry dengan fallback API Key
            while (attempt < maxRetry) {
                attempt++;
                console.log(`[Upload Attempt ${attempt}/${maxRetry}] ${fileName}`);

                const selectedKey = await findAvailableApiKey();
                if (!selectedKey) {
                    throw new Error('🚫 Semua API Key kehabisan quota upload bulanan!');
                }

                const quotaInfo = selectedKey.cookie ? quotaCache.get(selectedKey.cookie) : null;
                const quotaLabel = quotaInfo
                    ? `${quotaInfo.remaining}/${quotaInfo.capacity} sisa`
                    : 'quota tidak dicek (no cookie)';

                try {
                    console.log(`[Using Key] ${selectedKey.name} — ${quotaLabel}`);
                    const operationId = await uploadToRoblox(filePath, fileName, selectedKey.apiKey);

                    if (selectedKey.cookie) decrementQuotaCache(selectedKey.cookie);

                    // Polling operasi upload hingga dapat assetId
                    const { assetId } = await pollOperationStatus(
                        operationId,
                        selectedKey.apiKey,
                        SETTINGS.polling_interval_ms
                    );

                    if (!assetId || assetId === '-') {
                        throw new Error('Asset ID tidak ditemukan setelah upload selesai.');
                    }

                    console.log(`[Upload OK] ${fileName} → Asset ID: ${assetId}`);
                    uploadedAssets.push({
                        name: fileName,
                        assetId,
                        apiKey: selectedKey.apiKey,
                        usedKey: selectedKey.name,
                        quota: quotaLabel
                    });
                    break; // Sukses

                } catch (uploadError) {
                    const errMsg = JSON.stringify(uploadError.response?.data || uploadError.message);
                    console.warn(`[Attempt ${attempt} Failed] ${uploadError.message}`);

                    const isQuotaError =
                        errMsg.includes('quota') ||
                        errMsg.includes('RESOURCE_EXHAUSTED') ||
                        uploadError.response?.status === 429;

                    if (isQuotaError && selectedKey.cookie) {
                        console.warn(`[Quota] ${selectedKey.name} quota habis → invalidate cache.`);
                        invalidateQuotaCache(selectedKey.cookie);
                        attempt--;
                    }

                    if (attempt >= maxRetry) throw uploadError;
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

        } catch (err) {
            console.error(`[ERROR Upload] ${fileName}:`, err.response?.data || err.message);
            results.push({
                name: fileName,
                id: '-',
                status: `❌ ERROR: ${err.message?.substring(0, 80) || 'Unknown'}`
            });
        } finally {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`[Cleanup] Deleted ${filePath}`);
            }
        }
    }

    // Ringkasan hasil upload sebelum menunggu moderasi
    if (uploadedAssets.length > 0) {
        let uploadSummary = `✅ **${uploadedAssets.length}/${attachmentList.length} file berhasil diupload!**\n`;
        uploadedAssets.forEach((a, i) => {
            uploadSummary += `\`${i + 1}. ${a.name} → Asset ID: ${a.assetId}\`\n`;
        });
        uploadSummary += `\n⏳ Menunggu moderasi semua file secara paralel...`;
        await message.reply(uploadSummary);
    }

    // ========== FASE 2: CEK MODERASI SEMUA SECARA PARALEL ==========
    const moderationResults = await Promise.all(
        uploadedAssets.map(async (asset) => {
            const rawStatus = await pollModerationStatus(asset.assetId, asset.apiKey);

            // Auto-archive jika ditolak moderasi
            let archived = false;
            if (rawStatus?.toLowerCase() === 'rejected') {
                archived = await archiveAsset(asset.assetId, asset.apiKey);
            }

            return {
                name: asset.name,
                id: asset.assetId,
                status: formatModerationStatus(rawStatus) + (archived ? ' (auto-archived)' : ''),
                usedKey: asset.usedKey,
                quota: asset.quota
            };
        })
    );

    results.push(...moderationResults);

    // Ambil sisa quota terbaru setelah semua upload selesai
    let quotaSummary = '';
    for (const entry of API_KEYS) {
        if (entry.cookie) {
            const quota = await checkQuota(entry.cookie);
            if (quota.remaining !== -1) {
                quotaSummary += `  🔑 ${entry.name}: ${quota.remaining}/${quota.capacity} sisa\n`;
            }
        }
    }

    // Kirim laporan hasil akhir
    let output = '📋 ===== HASIL UPLOAD =====\n\n';
    results.forEach((res, i) => {
        output += `${i + 1}. 🎵 ${res.name}\n`;
        output += `   🔗 Asset ID : ${res.id}\n`;
        output += `   📊 Status   : ${res.status}\n`;
        if (res.usedKey) output += `   🔑 Key      : ${res.usedKey}\n`;
        output += '\n';
    });

    if (quotaSummary) {
        output += `📦 ===== SISA QUOTA =====\n${quotaSummary}`;
    }

    message.reply('```' + output + '```');
});

// Handle error global
process.on('unhandledRejection', (reason) => {
    console.error('[Unhandled Rejection]', reason);
});

client.login(process.env.DISCORD_TOKEN);
