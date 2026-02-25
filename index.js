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

// Cache quota untuk menghindari spam API check
const quotaCache = new Map(); // key: apiKey, value: { remaining, resetAt, lastCheck }

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ==================== UTILITIES ====================

/**
 * Cek quota upload untuk sebuah API Key
 * @param {string} apiKey - Roblox Open Cloud API Key
 * @returns {Promise<{available: boolean, remaining: number, capacity: number}>}
 */
async function checkQuota(apiKey) {
    try {
        // Cek cache dulu (opsional, untuk efisiensi)
        const cached = quotaCache.get(apiKey);
        const now = Date.now();
        if (cached && cached.resetAt > now) {
            return {
                available: cached.remaining > 0,
                remaining: cached.remaining,
                capacity: cached.capacity
            };
        }

        const response = await axios.get(
            'https://publish.roblox.com/v1/asset-quotas',
            {
                params: {
                    resourceType: 'RateLimitUpload',
                    assetType: 'Audio'
                },
                headers: {
                    'x-api-key': apiKey,
                    'User-Agent': 'RobloxOpenCloud/1.0'
                }
            }
        );

        const quota = response.data.quotas?.[0];
        if (!quota) throw new Error('Quota data tidak ditemukan');

        const remaining = quota.capacity - quota.usage;
        const result = {
            available: remaining > 0,
            remaining: remaining,
            capacity: quota.capacity
        };

        // Simpan ke cache (asumsi reset bulanan = 30 hari)
        quotaCache.set(apiKey, {
            ...result,
            resetAt: now + (30 * 24 * 60 * 60 * 1000) // 30 hari
        });

        return result;

    } catch (error) {
        console.error(`[Quota Check ERROR] ${error.message}`);
        // Gagal cek? Anggap masih available agar tidak blocking
        return { available: true, remaining: -1, capacity: -1 };
    }
}

/**
 * Cari API Key pertama yang masih memiliki quota tersedia
 * @returns {Promise<{apiKey: string, name: string} | null>}
 */
async function findAvailableApiKey() {
    for (const entry of API_KEYS) {
        const quota = await checkQuota(entry.key);
        console.log(`[Quota] ${entry.name}: ${quota.remaining}/${quota.capacity} tersisa`);
        
        if (quota.available) {
            return { apiKey: entry.key, name: entry.name };
        }
        console.log(`[Skip] ${entry.name} quota habis, mencoba key berikutnya...`);
    }
    return null; // Semua key habis
}

/**
 * Upload file audio ke Roblox dengan API Key tertentu
 */
async function uploadToRoblox(filePath, fileName, apiKey) {
    const form = new FormData();
    
    form.append(
        "request",
        JSON.stringify({
            assetType: "Audio",
            displayName: fileName,
            description: "Uploaded via Discord Bot",
            creationContext: {
                creator: {
                    groupId: parseInt(ROBLOX_GROUP_ID)
                }
            }
        }),
        { contentType: "application/json" }
    );
    
    form.append("fileContent", fs.createReadStream(filePath));

    const uploadResponse = await axios.post(
        "https://apis.roblox.com/assets/v1/assets",
        form,
        {
            headers: {
                ...form.getHeaders(),
                "x-api-key": apiKey
            }
        }
    );

    return uploadResponse.data.path.split("/").pop(); // operationId
}

/**
 * Polling status operasi upload hingga selesai
 */
async function pollOperationStatus(operationId, apiKey, pollingInterval = 4000) {
    while (true) {
        const statusResponse = await axios.get(
            `https://apis.roblox.com/assets/v1/operations/${operationId}`,
            { headers: { "x-api-key": apiKey } }
        );

        if (statusResponse.data.done) {
            return {
                assetId: statusResponse.data.response?.assetId || "-",
                status: statusResponse.data.response?.moderationResult?.moderationState || "UNKNOWN"
            };
        }
        
        await new Promise(resolve => setTimeout(resolve, pollingInterval));
    }
}

// ==================== BOT EVENTS ====================

client.once('ready', () => {
    console.log(`✅ Bot login sebagai ${client.user.tag}`);
    console.log(`📊 Loaded ${API_KEYS.length} API Keys untuk fallback`);
    console.log(`🔒 Filter aktif: ${ALLOWED_CHANNELS.length} channel, ${ALLOWED_GUILDS.length} guild`);
});

client.on('messageCreate', async (message) => {
    // 🔒 FILTER 1: Hanya proses dari guild yang diizinkan (jika config diisi)
    if (ALLOWED_GUILDS.length > 0 && message.guild?.id && !ALLOWED_GUILDS.includes(message.guild.id)) {
        console.log(`[Ignored] Message from unauthorized guild: ${message.guild.name} (${message.guild.id})`);
        return;
    }
    
    // 🔒 FILTER 2: Hanya proses dari channel yang diizinkan (jika config diisi)
    if (ALLOWED_CHANNELS.length > 0 && !ALLOWED_CHANNELS.includes(message.channel.id)) {
        console.log(`[Ignored] Message from unauthorized channel: ${message.channel.name} (${message.channel.id})`);
        // Optional: Reply jika user mention bot di channel yang salah
        if (message.mentions.has(client.user)) {
            return message.reply(`🔒 Bot ini hanya aktif di channel yang diizinkan.`);
        }
        return;
    }

    // Abaikan pesan dari bot lain
    if (message.author.bot) return;

    // Cek apakah ada attachment
    if (message.attachments.size === 0) {
        return message.reply("📤 Upload file audio (mp3/ogg) untuk diproses.");
    }

    let results = [];

    for (const attachment of message.attachments.values()) {
        // Validasi tipe file
        if (!attachment.contentType?.startsWith("audio")) {
            results.push({ 
                name: attachment.name, 
                id: "-", 
                status: "❌ BUKAN FILE AUDIO" 
            });
            continue;
        }

        const fileName = path.parse(attachment.name).name;
        const filePath = `./${attachment.name}`;
        let attempt = 0;
        const maxRetry = SETTINGS.max_retry_per_upload || 3;

        try {
            // Download file dari Discord
            await message.reply(`⬇️ Mengunduh ${attachment.name}...`);
            const response = await axios.get(attachment.url, { responseType: 'stream' });
            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            // 🔁 Loop retry dengan fallback API Key
            while (attempt < maxRetry) {
                attempt++;
                console.log(`[Upload Attempt ${attempt}/${maxRetry}] ${fileName}`);

                // Cari API Key yang masih ada quota
                const selectedKey = await findAvailableApiKey();
                if (!selectedKey) {
                    throw new Error("🚫 Semua API Key kehabisan quota upload bulanan!");
                }

                console.log(`[Using Key] ${selectedKey.name} (Quota: ${quotaCache.get(selectedKey.apiKey)?.remaining})`);

                try {
                    // Upload ke Roblox
                    await message.reply(`⬆️ Mengupload ke Roblox menggunakan ${selectedKey.name}...`);
                    const operationId = await uploadToRoblox(filePath, fileName, selectedKey.apiKey);
                    
                    // Polling status
                    await message.reply(`🔄 Memproses... (Operation ID: ${operationId})`);
                    const { assetId, status } = await pollOperationStatus(
                        operationId, 
                        selectedKey.apiKey,
                        SETTINGS.polling_interval_ms
                    );

                    // Update cache quota (kurangi 1 karena baru upload)
                    const cached = quotaCache.get(selectedKey.apiKey);
                    if (cached && cached.remaining > 0) {
                        cached.remaining -= 1;
                        quotaCache.set(selectedKey.apiKey, cached);
                    }

                    results.push({
                        name: fileName,
                        id: assetId,
                        status: status.toUpperCase(),
                        usedKey: selectedKey.name
                    });
                    break; // Success, keluar dari loop retry

                } catch (uploadError) {
                    console.warn(`[Attempt ${attempt} Failed] ${uploadError.message}`);
                    
                    if (attempt === maxRetry) {
                        throw uploadError; // Lempar error jika sudah max retry
                    }
                    
                    // Tunggu sebentar sebelum retry
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

        } catch (err) {
            console.error(`[ERROR] ${fileName}:`, err.response?.data || err.message);
            results.push({
                name: fileName,
                id: "-",
                status: `❌ ERROR: ${err.message?.substring(0, 50) || "Unknown"}`
            });
        } finally {
            // Hapus file temp
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`[Cleanup] Deleted ${filePath}`);
            }
        }
    }

    // Kirim laporan hasil
    let output = "📋 ===== HASIL UPLOAD =====\n\n";
    results.forEach((res, i) => {
        output += `${i + 1}. 🎵 ${res.name}\n`;
        output += `   🔗 Asset ID: ${res.id}\n`;
        output += `   📊 Status: ${res.status}\n`;
        if (res.usedKey) output += `   🔑 Menggunakan: ${res.usedKey}\n`;
        output += "\n";
    });

    message.reply("```" + output + "```");
});

// Handle error global
process.on('unhandledRejection', (reason) => {
    console.error('[Unhandled Rejection]', reason);
});

client.login(process.env.DISCORD_TOKEN);