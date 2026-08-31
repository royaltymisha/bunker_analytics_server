const STEAM_API = 'https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/';

// Проверенные сессии держим в памяти: билет выдаётся один раз за запуск игры,
// а батчей за сессию прилетают десятки. Дёргать Steam на каждый — лишние
// сотни миллисекунд и риск упереться в их рейт-лимит.
// Память процесса, а не Redis: перезапуск сервиса просто заставит проверить заново.
const verifiedSessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function pruneExpired() {
    const now = Date.now();

    for (const [sessionId, entry] of verifiedSessions) {
        if (now - entry.at > SESSION_TTL_MS) {
            verifiedSessions.delete(sessionId);
        }
    }
}

/**
 * Подтверждает, что билет действительно выдан Steam этому SteamID и для нашего appid.
 * Без этого steam_id в батче — просто число, которое кто угодно может подставить curl'ом.
 *
 * @param {string} sessionId  id игровой сессии, ключ кэша
 * @param {string|null} ticket hex-строка от SteamUser.GetAuthTicketForWebApi
 * @returns {Promise<{ steamId: string|null, verified: boolean }>}
 */
export async function verifySteamTicket(sessionId, ticket) {
    const apiKey = process.env.STEAM_WEB_API_KEY;
    const appId = process.env.STEAM_APP_ID;

    if (!apiKey || !appId || !ticket || !sessionId) {
        return { steamId: null, verified: false };
    }

    const cached = verifiedSessions.get(sessionId);

    if (cached && Date.now() - cached.at <= SESSION_TTL_MS) {
        return { steamId: cached.steamId, verified: true };
    }

    const url = `${STEAM_API}?key=${encodeURIComponent(apiKey)}&appid=${encodeURIComponent(appId)}&ticket=${encodeURIComponent(ticket)}`;

    let payload;

    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

        if (!response.ok) {
            return { steamId: null, verified: false };
        }

        payload = await response.json();
    } catch {
        // Steam недоступен — событие всё равно принимаем, просто как непроверенное.
        return { steamId: null, verified: false };
    }

    const params = payload?.response?.params;

    if (params?.result !== 'OK' || !params?.steamid) {
        return { steamId: null, verified: false };
    }

    pruneExpired();
    verifiedSessions.set(sessionId, { steamId: params.steamid, at: Date.now() });

    return { steamId: params.steamid, verified: true };
}
